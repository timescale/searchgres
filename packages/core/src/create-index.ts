import type postgres from "postgres";
import { type IndexConfig, normalizeIndexConfig } from "./config.ts";
import { ensureExtension } from "./db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "./db/lock.ts";
import { ensurePostgresVersion } from "./db/preflight.ts";
import { createBatchUpsertRoutine } from "./db/routines/batch-upsert.ts";
import { createRecordRoutines } from "./db/routines/records.ts";
import { createSearchRoutines } from "./db/routines/search.ts";
import { createTreeRoutines } from "./db/routines/tree.ts";
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

            -- If the content changed but the caller did NOT supply a matching
            -- replacement vector in the same statement, the stored vector no
            -- longer describes the text. Null it so the async pipeline
            -- regenerates it. A caller MAY supply a fresh vector alongside the
            -- new content (new.embedding distinct from old.embedding); that is
            -- preserved and no regeneration is queued.
            if old.content is distinct from new.content
              and new.embedding is not distinct from old.embedding then
              new.embedding := null;
            end if;

            -- content_version is the EMBEDDING-INPUT FENCE, not a literal text
            -- counter. Advance it whenever the input to embedding generation
            -- changes: the content text changed, OR the stored vector itself
            -- changed (a caller supplied/replaced a precomputed vector, or
            -- cleared one to null). This single bump is the entire staleness
            -- mechanism: the worker's write-back is guarded by the
            -- content_version it claimed (see complete_embedding), so bumping
            -- here makes any already-queued OR in-flight work for the previous
            -- state fail that guard and cancel instead of clobbering the newer
            -- vector. It is what lets a late precomputed-embedding write win a
            -- race against a worker that already claimed the row — no extra
            -- trigger required.
            if old.content is distinct from new.content
              or new.embedding is distinct from old.embedding then
              new.content_version := old.content_version + 1;
            else
              new.content_version := old.content_version;
            end if;

            -- version/version_hash are optimistic-concurrency tokens over the
            -- user-visible fields only. The embedding is not user-visible, so an
            -- embedding-only change advances content_version (above) but NOT
            -- version, and leaves the hash untouched.
            if old.tree is distinct from new.tree
              or old.temporal is distinct from new.temporal
              or old.name is distinct from new.name
              or old.meta is distinct from new.meta
              or old.content is distinct from new.content
            then
              new.version := old.version + 1;
            else
              -- nothing user-visible changed
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
        set search_path to pg_catalog, public, pg_temp
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
        -- Enqueue whenever an update leaves the row needing an async vector. We
        -- key off content_version rather than re-deriving "what changed":
        -- record_integrity (BEFORE) has already advanced content_version iff the
        -- embedding input changed, and has already nulled a now-stale vector. So
        -- "vector is null AND content_version advanced" is exactly the set of
        -- updates that produced fresh work: content changed without a replacement
        -- (vector nulled), or a vector explicitly cleared to null. A supplied
        -- non-null vector advances content_version too (invalidating old queue
        -- rows) but needs no new work, so the "new.embedding is null" guard skips
        -- it. "of content, embedding" keeps metadata-only updates from firing.
        create trigger record_enqueue_after_embedding_input
        after update of content, embedding on ${tx(indexSchema)}.record
        for each row
        when
        (
          new.embedding is null
          and new.content_version is distinct from old.content_version
        )
        execute function ${tx(indexSchema)}.enqueue_record_embedding()
      `,
      {
        spanName: "createRecordEmbeddingInputEnqueueTrigger",
        dbOperationName: "CREATE",
        namespace: indexSchema,
      },
    );

    // ------------------------------------------------------------------------
    // create the schema-local routines
    // ------------------------------------------------------------------------
    await createBatchUpsertRoutine(tx, indexSchema, creation.vectorType);
    await createRecordRoutines(
      tx,
      indexSchema,
      creation.vectorType,
      creation.dimensions,
    );
    await createTreeRoutines(tx, indexSchema);
    await createSearchRoutines(
      tx,
      indexSchema,
      creation.vectorType,
      creation.dimensions,
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
