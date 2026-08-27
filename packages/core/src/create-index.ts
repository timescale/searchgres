import type postgres from "postgres";
import { type IndexConfig, normalizeIndexConfig } from "./config.ts";
import { ensureExtension } from "./db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "./db/lock.ts";
import { ensurePostgresVersion } from "./db/preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_LOCK_TIMEOUT,
  DEFAULT_MIGRATION_TIMEOUTS,
  setLockTimeout,
} from "./db/session.ts";
import { ConflictError, InvalidConfigError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";

export const SCHEMA_FORMAT_VERSION = "1";

const INITIAL_EXTENSIONS = [
  { name: "vector", minimumVersion: "0.8.0" },
  { name: "pg_textsearch", minimumVersion: "1.4.0" },
  { name: "ltree", minimumVersion: "1.3.0" },
] as const;

/**
 * Create a new immutable index schema. Rebuilding into a new schema is the
 * upgrade path; this operation never mutates or migrates an existing schema.
 */
export async function createIndex(
  sql: postgres.Sql,
  schema: string,
  config: IndexConfig,
): Promise<void> {
  const indexSchema = assertSchemaName(schema);
  const creation = normalizeIndexConfig(config);

  await sql.begin(async (tx) => {
    await applySessionTimeouts(tx, {
      ...DEFAULT_MIGRATION_TIMEOUTS,
      lockTimeout: DEFAULT_MIGRATION_LOCK_TIMEOUT,
    });
    await acquireAdvisoryLock(tx, advisoryLockKey("searchgres:create-index"));
    await setLockTimeout(tx, DEFAULT_MIGRATION_TIMEOUTS.lockTimeout);
    await ensurePostgresVersion(tx);

    const [existing] = await runSql(
      tx<{ readonly present: boolean }[]>`
        select exists
        (
          select 1
          from pg_catalog.pg_namespace n
          where n.nspname = ${indexSchema}
        ) as present
      `,
      { spanName: "schemaExists", dbOperationName: "SELECT" },
    );
    if (existing?.present) {
      throw new ConflictError(
        `Index schema ${JSON.stringify(indexSchema)} already exists`,
      );
    }

    // searchgres is public-only: every required extension is installed in and
    // resolved from `public`, so all extension objects are qualified as such.
    for (const requirement of INITIAL_EXTENSIONS) {
      await ensureExtension(tx, requirement);
    }

    const embeddingType = tx`public.${tx(creation.vectorType)}(${tx.unsafe(String(creation.dimensions))})`;
    const ltreeType = tx`public.ltree`;
    const cosineOpclass = tx`public.${tx(`${creation.vectorType}_cosine_ops`)}`;

    // ------------------------------------------------------------------------
    // validate text search configuration
    // ------------------------------------------------------------------------
    let textConfig: { readonly literal: string } | undefined;
    try {
      [textConfig] = await runSql(
        tx<{ readonly literal: string }[]>`
          select pg_catalog.quote_literal(c.oid::pg_catalog.regconfig::text) as literal
          from pg_catalog.pg_ts_config c
          where c.oid = ${creation.bm25.textConfig}::pg_catalog.regconfig
        `,
        { spanName: "validateTextConfig", dbOperationName: "SELECT" },
      );
    } catch (error) {
      if (postgresErrorCode(error) !== "42704") {
        throw error;
      }
    }
    if (!textConfig) {
      throw new InvalidConfigError(
        `Unknown text search configuration: ${creation.bm25.textConfig}`,
        {
          issues: [
            {
              code: "custom",
              message: "must name an installed text search configuration",
              path: ["bm25", "textConfig"],
            },
          ],
        },
      );
    }

    // ------------------------------------------------------------------------
    // create schema and version marker table
    // ------------------------------------------------------------------------
    await runSql(tx`create schema ${tx(indexSchema)}`, {
      spanName: "createIndexSchema",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    });
    // set local search path so certain extension-defined operators resolve
    await runSql(tx`set local search_path to pg_catalog, public, pg_temp`, {
      spanName: "setLocalSearchPath",
      dbOperationName: "SET",
      namespace: indexSchema,
    });
    await runSql(
      tx`
        create table ${tx(indexSchema)}.version
        ( version text not null
        , at timestamptz not null default pg_catalog.now()
        )
      `,
      {
        spanName: "createSchemaVersionTable",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create unique index version_singleton_idx on ${tx(indexSchema)}.version ((true))
      `,
      {
        spanName: "createSchemaVersionSingletonIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create record table and its indexes
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create table ${tx(indexSchema)}.record
        ( id uuid primary key default pg_catalog.uuidv7() check (pg_catalog.uuid_extract_version(id) = 7)
        , content text not null
        , meta jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(meta) = 'object')
        , tree ${ltreeType} not null default ''::${ltreeType}
        , name text
        , temporal tstzrange
        , embedding ${embeddingType}
        , content_version integer not null default 1 check (content_version > 0)
        , version bigint not null default 1 check (version > 0)
        , version_hash text not null
        , created_at timestamptz not null default pg_catalog.now()
        , updated_at timestamptz
        )
      `,
      {
        spanName: "createRecordTable",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        alter table ${tx(indexSchema)}.record add constraint record_temporal_bounds_convention_check
        check
        (
          temporal is null
          or
          (
            (
              pg_catalog.lower(temporal) = pg_catalog.upper(temporal)
              and pg_catalog.lower_inc(temporal)
              and pg_catalog.upper_inc(temporal)
            )
            or
            (
              pg_catalog.lower(temporal) < pg_catalog.upper(temporal)
              and pg_catalog.lower_inc(temporal)
              and not pg_catalog.upper_inc(temporal)
            )
          )
        )
      `,
      {
        spanName: "createRecordTemporalBoundsConventionCheck",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index record_meta_gin_idx on ${tx(indexSchema)}.record using gin (meta)
      `,
      {
        spanName: "createRecordMetaIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index record_temporal_gist_idx on ${tx(indexSchema)}.record using gist (temporal)
        where temporal is not null
      `,
      {
        spanName: "createRecordTemporalIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index record_content_bm25_idx on ${tx(indexSchema)}.record using bm25 (content)
        with
        ( text_config = ${tx.unsafe(textConfig.literal)}
        , k1 = ${tx.unsafe(String(creation.bm25.k1))}
        , b = ${tx.unsafe(String(creation.bm25.b))}
        )
      `,
      {
        spanName: "createRecordBm25Index",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index record_embedding_hnsw_idx on ${tx(indexSchema)}.record using hnsw (embedding ${cosineOpclass})
        with (
          m = ${tx.unsafe(String(creation.hnsw.m))},
          ef_construction = ${tx.unsafe(String(creation.hnsw.efConstruction))}
        )
      `,
      {
        spanName: "createRecordHnswIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index record_tree_gist_idx on ${tx(indexSchema)}.record using gist (tree)
      `,
      {
        spanName: "createRecordTreeIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create unique index record_tree_name_uidx on ${tx(indexSchema)}.record (tree, name)
        where name is not null
      `,
      {
        spanName: "createRecordNameIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create embedding queue table and its indexes
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create table ${tx(indexSchema)}.embedding_queue
        ( id bigint generated always as identity primary key
        , record_id uuid not null references ${tx(indexSchema)}.record(id) on delete cascade
        , content_version integer not null
        , visible_at timestamptz not null default pg_catalog.now()
        , outcome text check (outcome is null or outcome in ('completed', 'failed', 'cancelled'))
        , attempts integer not null default 0 check (attempts >= 0)
        , last_error text
        , created_at timestamptz not null default pg_catalog.now()
        , updated_at timestamptz
        )
      `,
      {
        spanName: "createEmbeddingQueue",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index embedding_queue_claim_idx on ${tx(indexSchema)}.embedding_queue (visible_at)
        where outcome is null
      `,
      {
        spanName: "createEmbeddingQueueClaimIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index embedding_queue_record_idx on ${tx(indexSchema)}.embedding_queue (record_id, content_version desc)
        where outcome is null
      `,
      {
        spanName: "createEmbeddingQueueRecordIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index embedding_queue_archive_idx on ${tx(indexSchema)}.embedding_queue (created_at)
        where outcome is not null
      `,
      {
        spanName: "createEmbeddingQueueArchiveIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create index embedding_queue_record_id_idx on ${tx(indexSchema)}.embedding_queue (record_id)
      `,
      {
        spanName: "createEmbeddingQueueRecordIdIndex",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create record integrity trigger
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create function ${tx(indexSchema)}.record_integrity()
        returns trigger
        language plpgsql volatile security invoker
        set timezone to 'UTC'
        set datestyle to 'ISO, YMD'
        set search_path to pg_catalog, public, pg_temp
        as $function$
        begin
          if tg_op = 'INSERT' then
            new.content_version := 1;
            new.version := 1;
          else
            new.updated_at := pg_catalog.now();
            -- if content changed, increment the content version
            if old.content is distinct from new.content then
              new.content_version := old.content_version + 1;
              -- if the content changed, the embedding should have changed
              -- if it didn't, null it out so it can be reprocessed async
              if new.embedding is not distinct from old.embedding then
                new.embedding := null;
              end if;
            else
              -- content didn't change so neither should content version
              new.content_version := old.content_version;
            end if;
            -- updated. did anything meaningful change?
            if old.tree is distinct from new.tree
              or old.temporal is distinct from new.temporal
              or old.name is distinct from new.name
              or old.meta is distinct from new.meta
              or old.content is distinct from new.content
            then
              new.version := old.version + 1;
            else
              -- nothing of note changed
              new.version := old.version;
              new.version_hash := old.version_hash;
              return new;
            end if;
          end if;

          -- compute the hash on inserts and updates that change something meaningful
          new.version_hash := pg_catalog.md5(
            pg_catalog.jsonb_build_object
            ( 'tree', new.tree::text
            , 'name', new.name
            , 'meta', new.meta
            , 'temporal', new.temporal::text
            , 'content', new.content
            )::text
          );
          return new;
        end;
        $function$
      `,
      {
        spanName: "createRecordIntegrityFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create trigger record_integrity_before_write
        before insert or update on ${tx(indexSchema)}.record
        for each row
        execute function ${tx(indexSchema)}.record_integrity()
      `,
      {
        spanName: "createRecordIntegrityTrigger",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create embedding enqueue function and triggers
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create function ${tx(indexSchema)}.enqueue_record_embedding()
        returns trigger
        language plpgsql volatile security invoker
        as $function$
        begin
          insert into ${tx(indexSchema)}.embedding_queue
            (record_id, content_version)
          values
            (new.id, new.content_version);
          return new;
        end;
        $function$
      `,
      {
        spanName: "createEmbeddingEnqueueFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create trigger record_enqueue_after_insert
        after insert on ${tx(indexSchema)}.record
        for each row
        when (new.embedding is null)
        execute function ${tx(indexSchema)}.enqueue_record_embedding()
      `,
      {
        spanName: "createRecordInsertEnqueueTrigger",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );
    await runSql(
      tx`
        create trigger record_enqueue_after_content_update
        after update of content on ${tx(indexSchema)}.record
        for each row
        when
        (
          old.content is distinct from new.content
          and (new.embedding is null or old.embedding is not distinct from new.embedding)
        )
        execute function ${tx(indexSchema)}.enqueue_record_embedding()
      `,
      {
        spanName: "createRecordContentEnqueueTrigger",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create batch_upsert routine
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create function ${tx(indexSchema)}.batch_upsert
        ( _ids uuid[]
        , _contents text[]
        , _metas jsonb
        , _trees public.ltree[]
        , _temporals tstzrange[]
        , _names text[]
        , _embeddings public.${tx(creation.vectorType)}[]
        , _on_conflict text default 'error'
        )
        returns table (ord bigint, id uuid, status text)
        language plpgsql volatile security invoker
        set timezone to 'UTC'
        set datestyle to 'ISO, YMD'
        set search_path to pg_catalog, public, pg_temp
        as $function$
        -- The out columns (id, ...) shadow table columns inside the body; the
        -- body never reads them as variables, so resolve ambiguity to columns.
        #variable_conflict use_column
        declare
          _rows jsonb;
        begin
          -- Parallel arrays plus one JSON array of meta objects, aligned by
          -- position. _metas is a jsonb array (not jsonb[]) so drivers pass json
          -- values without double-encoding scalar strings.
          if cardinality(_ids) is distinct from cardinality(_contents)
             or cardinality(_ids) is distinct from cardinality(_trees)
             or jsonb_typeof(_metas) is distinct from 'array'
             or cardinality(_ids) is distinct from jsonb_array_length(_metas)
             or cardinality(_ids) is distinct from cardinality(_temporals)
             or cardinality(_ids) is distinct from cardinality(_names)
             or cardinality(_ids) is distinct from cardinality(_embeddings)
          then
            raise exception 'batch arrays must have equal lengths'
              using errcode = 'invalid_parameter_value';
          end if;

          if _on_conflict is null or _on_conflict not in ('error', 'replace', 'ignore') then
            raise exception 'invalid _on_conflict: %', _on_conflict
              using errcode = 'invalid_parameter_value';
          end if;

          -- A duplicate idempotency key within the batch is ambiguous (two
          -- outcomes for one key) and would slip past the per-key partitions.
          if exists
          (
            select 1 from unnest(_ids) u(id)
            where u.id is not null
            group by u.id having count(*) > 1
          ) then
            raise exception 'duplicate explicit id within batch'
              using errcode = 'invalid_parameter_value';
          end if;
          if exists
          (
            select 1 from unnest(_trees, _names) u(tree, name)
            where u.name is not null
            group by u.tree, u.name having count(*) > 1
          ) then
            raise exception 'duplicate (tree, name) within batch'
              using errcode = 'invalid_parameter_value';
          end if;

          -- Two inputs with DIFFERENT keys can still resolve to the same
          -- existing row: an unnamed {id: X} and a {tree, name} slot already
          -- holding id X. Status is attributed by stored id, so that would mark
          -- both inputs from one write. Reject it. Skip the probe when either an
          -- explicit-id input or a named input is absent.
          if cardinality(array_remove(_ids, null)) > 0
             and exists (select 1 from unnest(_names) n(name) where n.name is not null)
             and exists
          (
            select 1 from
            (
              select m.id
              from unnest(_ids, _names) u(id, name)
              join ${tx(indexSchema)}.record m on m.id = u.id
              where u.id is not null and u.name is null
              union all
              select m.id
              from unnest(_trees, _names) u(tree, name)
              join ${tx(indexSchema)}.record m on m.tree = u.tree and m.name = u.name
              where u.name is not null
            ) x
            group by x.id having count(*) > 1
          ) then
            raise exception 'batch inputs target the same existing record through id and (tree, name)'
              using errcode = 'invalid_parameter_value';
          end if;

          -- One mutation statement (one snapshot). Its per-input outcomes are
          -- captured so a second statement can resolve skipped named rows.
          with source as
          (
            select
              u.ord::bigint as position
            , u.id as explicit_id
            , coalesce(u.id, uuidv7()) as id
            , u.content
            , coalesce(nullif(e.meta, 'null'::jsonb), '{}'::jsonb) as meta
            , u.tree
            , u.temporal
            , u.name
            , u.embedding
            from unnest(_ids, _contents, _trees, _temporals, _names, _embeddings)
              with ordinality u(id, content, tree, temporal, name, embedding, ord)
            join jsonb_array_elements(_metas) with ordinality e(meta, ord)
              on e.ord = u.ord
          )
          -- Named rows (with OR without an explicit id) dedup on (tree, name).
          , named_mutation as
          (
            insert into ${tx(indexSchema)}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is not null
            on conflict (tree, name) where name is not null do update set
              content = excluded.content
            , meta = excluded.meta
            , temporal = excluded.temporal
            , embedding = case
                when excluded.embedding is null
                  and record.content is not distinct from excluded.content
                then record.embedding
                else excluded.embedding
              end
            where _on_conflict = 'replace'
              and
              (
                record.content is distinct from excluded.content
                or record.meta is distinct from excluded.meta
                or record.temporal is distinct from excluded.temporal
                or
                (
                  excluded.embedding is not null
                  and record.embedding::text is distinct from excluded.embedding::text
                )
              )
            returning record.id, record.tree::text as tree, record.name, (xmax = 0) as inserted
          )
          -- Unnamed rows with an explicit id dedup on the id (import identity);
          -- an id-keyed replace can also move or rename the row.
          , id_mutation as
          (
            insert into ${tx(indexSchema)}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is null and explicit_id is not null
            on conflict (id) do update set
              tree = excluded.tree
            , name = excluded.name
            , content = excluded.content
            , meta = excluded.meta
            , temporal = excluded.temporal
            , embedding = case
                when excluded.embedding is null
                  and record.content is not distinct from excluded.content
                then record.embedding
                else excluded.embedding
              end
            where _on_conflict = 'replace'
              and
              (
                record.tree is distinct from excluded.tree
                or record.name is distinct from excluded.name
                or record.content is distinct from excluded.content
                or record.meta is distinct from excluded.meta
                or record.temporal is distinct from excluded.temporal
                or
                (
                  excluded.embedding is not null
                  and record.embedding::text is distinct from excluded.embedding::text
                )
              )
            returning record.id, record.tree::text as tree, record.name, (xmax = 0) as inserted
          )
          -- Anonymous rows always insert (their generated id is unique).
          , anonymous_mutation as
          (
            insert into ${tx(indexSchema)}.record as record
              (id, content, meta, tree, temporal, name, embedding)
            select id, content, meta, tree, temporal, name, embedding
            from source
            where name is null and explicit_id is null
            returning record.id, record.tree::text as tree, record.name, true as inserted
          )
          , mutation as
          (
            select id, tree, name, inserted from named_mutation
            union all
            select id, tree, name, inserted from id_mutation
            union all
            select id, tree, name, inserted from anonymous_mutation
          )
          select jsonb_agg
          (
            jsonb_build_object
            ( 'position', source.position
            , 'mutation_id', mutation.id
            , 'source_id', source.id
            , 'tree', source.tree::text
            , 'name', source.name
            , 'status', case
                when mutation.id is null then 'skipped'
                when mutation.inserted then 'inserted'
                else 'updated'
              end
            )
            order by source.position
          )
          into _rows
          from source
          left outer join mutation
            on
            (
              source.name is not null
              and mutation.tree = source.tree::text
              and mutation.name = source.name
            )
            or
            (
              source.name is null
              and mutation.id = source.id
            );

          -- 'error' does nothing on conflict above (like 'ignore'), then fails
          -- the whole statement here so partial inserts roll back.
          if _on_conflict = 'error'
             and _rows is not null
             and exists
             (
               select 1 from jsonb_array_elements(_rows) e
               where e->>'status' = 'skipped'
             )
          then
            raise exception 'record already exists (id or tree/name conflict)'
              using errcode = 'unique_violation';
          end if;

          -- A skipped named row's stored id is resolved against a FRESH snapshot
          -- (a new statement), so a concurrently committed conflicting row yields
          -- its kept id rather than this batch's minted id.
          return query
          select
            (e->>'position')::bigint as ord
          , coalesce
            ( (e->>'mutation_id')::uuid
            , case
                when e->>'name' is null then (e->>'source_id')::uuid
                else
                (
                  select r.id
                  from ${tx(indexSchema)}.record r
                  where r.tree::text = e->>'tree' and r.name = e->>'name'
                )
              end
            ) as id
          , e->>'status' as status
          from jsonb_array_elements(coalesce(_rows, '[]'::jsonb)) e
          order by (e->>'position')::bigint;
        end;
        $function$
      `,
      {
        spanName: "createBatchUpsertFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create the filter compiler routine
    // ------------------------------------------------------------------------
    // compile_filter turns a validated boolean-AST JSONB into a parenthesized
    // SQL predicate. Only compiler-owned structure (columns, operators, casts,
    // generated JSON paths) becomes SQL text; every leaf VALUE stays data,
    // referenced from the bound filter parameter via the runtime `_expr` path
    // (the caller passes `$1` for the root). Extension objects are public-only.
    await runSql(
      tx`
        create function ${tx(indexSchema)}.compile_filter
        ( _node jsonb
        , _expr text
        , _depth int default 1
        )
        returns text
        language plpgsql stable security invoker
        set search_path to pg_catalog, public, pg_temp
        as $function$
        declare
          _keys text[];
          _key text;
          _out text;
        begin
          if _node is null then
            return 'true';
          end if;
          if _depth > 16 then
            raise exception 'filter nesting exceeds the maximum depth of 16'
              using errcode = 'invalid_parameter_value';
          end if;
          if jsonb_typeof(_node) is distinct from 'object' then
            raise exception 'filter node must be a json object'
              using errcode = 'invalid_parameter_value';
          end if;
          select array_agg(k) into _keys from jsonb_object_keys(_node) k;
          if _keys is null or array_length(_keys, 1) <> 1 then
            raise exception 'filter node must have exactly one key'
              using errcode = 'invalid_parameter_value';
          end if;
          _key := _keys[1];

          if _key in ('and', 'or') then
            if jsonb_typeof(_node -> _key) is distinct from 'array'
               or jsonb_array_length(_node -> _key) < 2 then
              raise exception '% requires at least two children', _key
                using errcode = 'invalid_parameter_value';
            end if;
            select '(' || string_agg
              ( ${tx(indexSchema)}.compile_filter
                ( e.elem
                , format('(%s -> %L -> %s)', _expr, _key, e.ord - 1)
                , _depth + 1
                )
              , case _key when 'and' then ' and ' else ' or ' end
              order by e.ord
              ) || ')'
            into _out
            from jsonb_array_elements(_node -> _key) with ordinality e(elem, ord);
            return _out;
          elsif _key = 'not' then
            return '(not ' || ${tx(indexSchema)}.compile_filter
              (_node -> 'not', format('(%s -> %L)', _expr, 'not'), _depth + 1) || ')';
          elsif _key = 'tree' then
            return format('coalesce((%s ->> %L)::public.ltree operator(public.@>) m.tree, false)', _expr, 'tree');
          elsif _key = 'lquery' then
            return format('coalesce(m.tree operator(public.~) (%s ->> %L)::public.lquery, false)', _expr, 'lquery');
          elsif _key = 'ltxtquery' then
            return format('coalesce(m.tree operator(public.@) (%s ->> %L)::public.ltxtquery, false)', _expr, 'ltxtquery');
          elsif _key = 'meta' then
            if jsonb_typeof(_node -> 'meta') is distinct from 'object'
               or _node -> 'meta' = '{}'::jsonb then
              raise exception 'meta filter must be a non-empty object'
                using errcode = 'invalid_parameter_value';
            end if;
            return format('coalesce(m.meta @> (%s -> %L), false)', _expr, 'meta');
          elsif _key = 'metaPredicate' then
            return format('coalesce(m.meta @@ (%s ->> %L)::jsonpath, false)', _expr, 'metaPredicate');
          elsif _key = 'temporalWithin' then
            return format('coalesce((%s ->> %L)::tstzrange @> m.temporal, false)', _expr, 'temporalWithin');
          elsif _key = 'temporalOverlaps' then
            return format('coalesce((%s ->> %L)::tstzrange && m.temporal, false)', _expr, 'temporalOverlaps');
          elsif _key = 'temporalBefore' then
            return format('coalesce(m.temporal << tstzrange((%1$s ->> %2$L)::timestamptz, (%1$s ->> %2$L)::timestamptz, ''[]''), false)', _expr, 'temporalBefore');
          elsif _key = 'temporalAfter' then
            return format('coalesce(m.temporal >> tstzrange((%1$s ->> %2$L)::timestamptz, (%1$s ->> %2$L)::timestamptz, ''[]''), false)', _expr, 'temporalAfter');
          elsif _key = 'temporalContains' then
            return format('coalesce(m.temporal @> (%s ->> %L)::timestamptz, false)', _expr, 'temporalContains');
          elsif _key = 'regexp' then
            return format('coalesce(m.content ~* (%s ->> %L), false)', _expr, 'regexp');
          end if;

          raise exception 'unknown filter key: %', _key
            using errcode = 'invalid_parameter_value';
        end;
        $function$
      `,
      {
        spanName: "createCompileFilterFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create the regex-safety analyzer routine
    // ------------------------------------------------------------------------
    // Returns {"g":guard,"r":has_regex,"u":unguarded}. Used only for a
    // filter-only search to enforce that a regex is never the sole scan driver
    // and never appears under `not`.
    await runSql(
      tx`
        create function ${tx(indexSchema)}.analyze_filter
        ( _node jsonb
        , _ranked boolean
        )
        returns jsonb
        language plpgsql stable security invoker
        set search_path to pg_catalog, public, pg_temp
        as $function$
        declare
          _key text;
          _child jsonb;
          _g boolean := false;
          _r boolean := false;
          _u boolean := false;
          _any_guard boolean := false;
          _all_guard boolean := true;
          _any_regex boolean := false;
          _any_unguarded boolean := false;
        begin
          if _node is null then
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          end if;
          select k into _key from jsonb_object_keys(_node) k limit 1;

          if _key in ('and', 'or') then
            for _child in select * from jsonb_array_elements(_node -> _key) loop
              declare _a jsonb := ${tx(indexSchema)}.analyze_filter(_child, _ranked);
              begin
                _any_guard := _any_guard or (_a ->> 'g')::boolean;
                _all_guard := _all_guard and (_a ->> 'g')::boolean;
                _any_regex := _any_regex or (_a ->> 'r')::boolean;
                _any_unguarded := _any_unguarded or (_a ->> 'u')::boolean;
              end;
            end loop;
            if _key = 'and' then
              return jsonb_build_object('g', _any_guard, 'r', _any_regex, 'u', _any_unguarded and not _any_guard);
            else
              return jsonb_build_object('g', _all_guard and not _any_regex, 'r', _any_regex, 'u', _any_unguarded);
            end if;
          elsif _key = 'not' then
            if (${tx(indexSchema)}.analyze_filter(_node -> 'not', _ranked) ->> 'r')::boolean and not _ranked then
              raise exception 'a regexp filter may not appear under not in a filter-only search'
                using errcode = 'invalid_parameter_value';
            end if;
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          elsif _key = 'regexp' then
            return jsonb_build_object('g', false, 'r', true, 'u', true);
          elsif _key = 'metaPredicate' then
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          end if;
          return jsonb_build_object('g', true, 'r', false, 'u', false);
        end;
        $function$
      `,
      {
        spanName: "createAnalyzeFilterFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create search_records routine (filter-only, keyword, or semantic)
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create function ${tx(indexSchema)}.search_records
        ( _filter jsonb default null
        , _fulltext text default null
        , _vec ${embeddingType} default null
        , _min_similarity float8 default null
        , _limit bigint default 10
        , _order text default 'desc'
        , _after uuid default null
        , _before uuid default null
        )
        returns table
        ( id uuid
        , content text
        , meta jsonb
        , tree public.ltree
        , temporal tstzrange
        , name text
        , has_embedding boolean
        , version bigint
        , version_hash text
        , created_at timestamptz
        , updated_at timestamptz
        , score float8
        )
        language plpgsql stable security invoker
        set search_path to pg_catalog, public, pg_temp
        as $function$
        #variable_conflict use_column
        declare
          _where text;
          _score text;
          _order_by text;
          _extra text := '';
          _sql text;
          _lim bigint;
          _bm25q public.bm25query;
          _max_dist float8;
        begin
          if _fulltext is not null and _vec is not null then
            raise exception 'provide either _fulltext or _vec, not both'
              using errcode = 'invalid_parameter_value';
          end if;
          if _min_similarity is not null and _vec is null then
            raise exception '_min_similarity requires _vec'
              using errcode = 'invalid_parameter_value';
          end if;
          if _min_similarity is not null and not (_min_similarity between 0 and 1) then
            raise exception '_min_similarity must be between 0 and 1'
              using errcode = 'invalid_parameter_value';
          end if;
          if (_after is not null or _before is not null)
             and (_fulltext is not null or _vec is not null) then
            raise exception 'cursors are only valid for a filter-only search'
              using errcode = 'invalid_parameter_value';
          end if;

          _lim := greatest(least(coalesce(_limit, 10), 1000), 1);

          if _filter is null then
            _where := '$1 is null';
          else
            _where := ${tx(indexSchema)}.compile_filter(_filter, '$1', 1);
            if _fulltext is null and _vec is null then
              perform 1 where (${tx(indexSchema)}.analyze_filter(_filter, false) ->> 'u')::boolean;
              if found then
                raise exception 'a regexp filter must be accompanied by an indexable filter (tree, lquery, ltxtquery, meta, or temporal)'
                  using errcode = 'invalid_parameter_value';
              end if;
            end if;
          end if;

          if _fulltext is not null then
            _bm25q := public.to_bm25query(_fulltext, ${tx.unsafe(`'${indexSchema}.record_content_bm25_idx'`)});
            _score := '-(m.content operator(public.<@>) $2) as score';
            _order_by := 'm.content operator(public.<@>) $2, m.id';
            _extra := 'and (m.content operator(public.<@>) $2) < 0';
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from ${tx(indexSchema)}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter, _bm25q;

          elsif _vec is not null then
            -- iterative HNSW so filters do not shrink the result below the limit;
            -- strict_order keeps distance order for RRF ranks. Transaction-local.
            perform set_config('hnsw.iterative_scan', 'strict_order', true);
            _score := '1 - (m.embedding operator(public.<=>) $2) as score';
            _order_by := 'm.embedding operator(public.<=>) $2, m.id';
            _extra := 'and m.embedding is not null';
            if _min_similarity is not null then
              _max_dist := 1 - _min_similarity;
              _extra := _extra || format(' and (m.embedding operator(public.<=>) $2) <= %s::float8', _max_dist);
            end if;
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from ${tx(indexSchema)}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter, _vec;

          else
            _score := '(-1)::float8 as score';
            if lower(coalesce(_order, 'desc')) = 'asc' then
              _order_by := 'm.id asc';
              if _after is not null then
                _extra := format('and m.id > %L::uuid', _after);
              elsif _before is not null then
                _extra := format('and m.id < %L::uuid', _before);
              end if;
            else
              _order_by := 'm.id desc';
              if _after is not null then
                _extra := format('and m.id < %L::uuid', _after);
              elsif _before is not null then
                _extra := format('and m.id > %L::uuid', _before);
              end if;
            end if;
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from ${tx(indexSchema)}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter;
          end if;
        end;
        $function$
      `,
      {
        spanName: "createSearchRecordsFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create hybrid_search_records routine (RRF over both arms)
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        create function ${tx(indexSchema)}.hybrid_search_records
        ( _filter jsonb default null
        , _fulltext text default null
        , _vec ${embeddingType} default null
        , _min_similarity float8 default null
        , _k float8 default 60.0
        , _candidate_limit bigint default 30
        , _fulltext_weight float8 default 1.0
        , _semantic_weight float8 default 1.0
        , _limit bigint default 10
        )
        returns table
        ( id uuid
        , content text
        , meta jsonb
        , tree public.ltree
        , temporal tstzrange
        , name text
        , has_embedding boolean
        , version bigint
        , version_hash text
        , created_at timestamptz
        , updated_at timestamptz
        , score float8
        )
        language plpgsql stable security invoker
        set search_path to pg_catalog, public, pg_temp
        as $function$
        #variable_conflict use_column
        declare
          _k_eff float8;
          _lim bigint;
          _cand bigint;
          _fw float8;
          _sw float8;
        begin
          if _fulltext is null then
            raise exception '_fulltext must not be null'
              using errcode = 'invalid_parameter_value';
          end if;
          if _vec is null then
            raise exception '_vec must not be null'
              using errcode = 'invalid_parameter_value';
          end if;
          _k_eff := greatest(coalesce(_k, 60.0), 0.0);
          _lim := greatest(least(coalesce(_limit, 10), 1000), 1);
          _cand := greatest(least(coalesce(_candidate_limit, 30), 1000), _lim);
          _fw := greatest(least(coalesce(_fulltext_weight, 1.0), 1.0), 0.0);
          _sw := greatest(least(coalesce(_semantic_weight, 1.0), 1.0), 0.0);

          return query
          select
            coalesce(f.id, s.id) as id
          , coalesce(f.content, s.content) as content
          , coalesce(f.meta, s.meta) as meta
          , coalesce(f.tree, s.tree) as tree
          , coalesce(f.temporal, s.temporal) as temporal
          , coalesce(f.name, s.name) as name
          , coalesce(f.has_embedding, s.has_embedding) as has_embedding
          , coalesce(f.version, s.version) as version
          , coalesce(f.version_hash, s.version_hash) as version_hash
          , coalesce(f.created_at, s.created_at) as created_at
          , coalesce(f.updated_at, s.updated_at) as updated_at
          ,   coalesce(_fw / (_k_eff + f.rank), 0.0)
            + coalesce(_sw / (_k_eff + s.rank), 0.0) as score
          from
          (
            select row_number() over (order by r.score desc, r.id) as rank, r.*
            from ${tx(indexSchema)}.search_records
              (_filter => _filter, _fulltext => _fulltext, _limit => _cand) r
          ) f
          full outer join
          (
            select row_number() over (order by r.score desc, r.id) as rank, r.*
            from ${tx(indexSchema)}.search_records
              (_filter => _filter, _vec => _vec, _min_similarity => _min_similarity, _limit => _cand) r
          ) s on f.id = s.id
          order by score desc, id
          limit _lim;
        end;
        $function$
      `,
      {
        spanName: "createHybridSearchRecordsFunction",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // record the schema format marker
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        insert into ${tx(indexSchema)}.version (version)
        values (${SCHEMA_FORMAT_VERSION})
      `,
      {
        spanName: "recordSchemaVersion",
        dbOperationName: "INSERT",
        namespace: indexSchema,
      },
    );
  });
}
