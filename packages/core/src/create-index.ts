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

    await runSql(tx`create schema ${tx(indexSchema)}`, {
      spanName: "createIndexSchema",
      dbOperationName: "CREATE",
      namespace: indexSchema,
    });
    // set local search path so certain extension-defined operators resolve
    await runSql(
      tx`set local search_path to pg_catalog, ${tx(indexSchema)}, ${tx(vector.schema)}, ${tx(ltree.schema)}, pg_temp`,
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
    await runSql(
      tx`
        create table ${tx(indexSchema)}.record
        ( id uuid primary key default pg_catalog.uuidv7()
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
