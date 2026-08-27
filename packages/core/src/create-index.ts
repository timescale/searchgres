import type postgres from "postgres";
import { type IndexConfig, normalizeIndexConfig } from "./config.ts";
import { type ExtensionInfo, ensureExtension } from "./db/extensions.ts";
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

    const extensions: ExtensionInfo[] = [];
    for (const requirement of INITIAL_EXTENSIONS) {
      extensions.push(await ensureExtension(tx, requirement));
    }
    const vector = extensions.find((extension) => extension.name === "vector");
    const ltree = extensions.find((extension) => extension.name === "ltree");
    if (!vector || !ltree) {
      throw new Error("Required extension setup invariant failed");
    }

    const embeddingType = tx`${tx(vector.schema)}.${tx(creation.vectorType)}(${tx.unsafe(String(creation.dimensions))})`;
    const ltreeType = tx`${tx(ltree.schema)}.ltree`;
    const cosineOpclass = tx`${tx(vector.schema)}.${tx(`${creation.vectorType}_cosine_ops`)}`;
    const operatorSchemas = [
      ...new Set([indexSchema, vector.schema, ltree.schema]),
    ];

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
    await runSql(
      tx`set local search_path to pg_catalog, ${tx(operatorSchemas)}, pg_temp`,
      {
        spanName: "setLocalSearchPath",
        dbOperationName: "SET",
        namespace: indexSchema,
      },
    );
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
        set search_path to pg_catalog, ${tx(vector.schema)}, ${tx(ltree.schema)}, pg_temp
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
        , _trees ${tx(ltree.schema)}.ltree[]
        , _temporals tstzrange[]
        , _names text[]
        , _embeddings ${tx(vector.schema)}.${tx(creation.vectorType)}[]
        , _on_conflict text default 'error'
        )
        returns table (ord bigint, id uuid, status text)
        language plpgsql volatile security invoker
        set timezone to 'UTC'
        set datestyle to 'ISO, YMD'
        set search_path to pg_catalog, ${tx(vector.schema)}, ${tx(ltree.schema)}, pg_temp
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
