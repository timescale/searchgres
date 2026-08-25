import type postgres from "postgres";
import { InvalidConfigError } from "../errors.ts";
import { postgresErrorCode } from "../sql/errors.ts";
import { runSql } from "../sql/exec.ts";
import type { Migration, MigrationContext } from "./types.ts";

export const INITIAL_MIGRATIONS: readonly Migration[] = [
  {
    name: "001_record_table",
    minLibraryVersion: "0.0.0",
    up: createRecordTable,
  },
  {
    name: "002_indexes",
    minLibraryVersion: "0.0.0",
    up: createRecordIndexes,
  },
  {
    name: "003_embedding_queue",
    minLibraryVersion: "0.0.0",
    up: createEmbeddingQueue,
  },
  {
    name: "004_integrity_triggers",
    minLibraryVersion: "0.0.0",
    up: createIntegrityTriggers,
  },
];

async function createRecordTable(
  tx: postgres.TransactionSql,
  context: MigrationContext,
): Promise<void> {
  const creation = requireCreation(context);
  const vector = requireExtension(context, "vector");
  const ltree = requireExtension(context, "ltree");
  const embeddingType = tx`${tx(vector.schema)}.${tx(creation.vectorType)}(${tx.unsafe(String(creation.dimensions))})`;
  const ltreeType = tx`${tx(ltree.schema)}.ltree`;

  await runSql(
    tx`
      create table ${tx(context.schema)}.record
      (
        id uuid primary key default pg_catalog.uuidv7(),
        content text not null,
        meta jsonb not null default '{}'::jsonb
          check (pg_catalog.jsonb_typeof(meta) = 'object'),
        tree ${ltreeType} not null default ''::${ltreeType},
        temporal tstzrange
          check (
            temporal is null
            or (
              (
                pg_catalog.lower(temporal) = pg_catalog.upper(temporal)
                and pg_catalog.lower_inc(temporal)
                and pg_catalog.upper_inc(temporal)
              )
              or (
                pg_catalog.lower(temporal) < pg_catalog.upper(temporal)
                and pg_catalog.lower_inc(temporal)
                and not pg_catalog.upper_inc(temporal)
              )
            )
          ),
        name text,
        embedding ${embeddingType},
        content_version integer not null default 1,
        version bigint not null default 1 check (version > 0),
        version_hash text not null,
        created_at timestamptz not null default pg_catalog.now(),
        updated_at timestamptz
      )
    `,
    {
      spanName: "createRecordTable",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
}

async function createRecordIndexes(
  tx: postgres.TransactionSql,
  context: MigrationContext,
): Promise<void> {
  const creation = requireCreation(context);
  const vector = requireExtension(context, "vector");
  const textConfigLiteral = await validatedTextConfigLiteral(
    tx,
    creation.bm25.textConfig,
  );
  const cosineOpclass = tx`${tx(vector.schema)}.${tx(`${creation.vectorType}_cosine_ops`)}`;

  await runSql(
    tx`
      create index record_meta_gin_idx
      on ${tx(context.schema)}.record using gin (meta)
    `,
    {
      spanName: "createRecordMetaIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index record_temporal_gist_idx
      on ${tx(context.schema)}.record using gist (temporal)
      where temporal is not null
    `,
    {
      spanName: "createRecordTemporalIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index record_content_bm25_idx
      on ${tx(context.schema)}.record using bm25 (content)
      with (
        text_config = ${tx.unsafe(textConfigLiteral)},
        k1 = ${tx.unsafe(String(creation.bm25.k1))},
        b = ${tx.unsafe(String(creation.bm25.b))}
      )
    `,
    {
      spanName: "createRecordBm25Index",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index record_embedding_hnsw_idx
      on ${tx(context.schema)}.record using hnsw (embedding ${cosineOpclass})
      with (
        m = ${tx.unsafe(String(creation.hnsw.m))},
        ef_construction = ${tx.unsafe(String(creation.hnsw.efConstruction))}
      )
    `,
    {
      spanName: "createRecordHnswIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index record_tree_gist_idx
      on ${tx(context.schema)}.record using gist (tree)
    `,
    {
      spanName: "createRecordTreeIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create unique index record_tree_name_uidx
      on ${tx(context.schema)}.record (tree, name)
      where name is not null
    `,
    {
      spanName: "createRecordNameIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
}

async function createEmbeddingQueue(
  tx: postgres.TransactionSql,
  context: MigrationContext,
): Promise<void> {
  await runSql(
    tx`
      create table ${tx(context.schema)}.embedding_queue
      (
        id bigint generated always as identity primary key,
        record_id uuid not null references ${tx(context.schema)}.record(id) on delete cascade,
        content_version integer not null,
        visible_at timestamptz not null default pg_catalog.now(),
        outcome text check (outcome is null or outcome in ('completed', 'failed', 'cancelled')),
        attempts integer not null default 0,
        last_error text,
        created_at timestamptz not null default pg_catalog.now(),
        updated_at timestamptz
      )
    `,
    {
      spanName: "createEmbeddingQueue",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index embedding_queue_claim_idx
      on ${tx(context.schema)}.embedding_queue (visible_at)
      where outcome is null
    `,
    {
      spanName: "createEmbeddingQueueClaimIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index embedding_queue_record_idx
      on ${tx(context.schema)}.embedding_queue (record_id, content_version desc)
      where outcome is null
    `,
    {
      spanName: "createEmbeddingQueueRecordIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index embedding_queue_archive_idx
      on ${tx(context.schema)}.embedding_queue (created_at)
      where outcome is not null
    `,
    {
      spanName: "createEmbeddingQueueArchiveIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create index embedding_queue_record_id_idx
      on ${tx(context.schema)}.embedding_queue (record_id)
    `,
    {
      spanName: "createEmbeddingQueueRecordIdIndex",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
}

async function createIntegrityTriggers(
  tx: postgres.TransactionSql,
  context: MigrationContext,
): Promise<void> {
  await runSql(
    tx`
      create function ${tx(context.schema)}.record_integrity()
      returns trigger
      language plpgsql
      set timezone to 'UTC'
      set datestyle to 'ISO, YMD'
      as $function$
      begin
        if tg_op = 'INSERT' then
          new.embedding := null;
          new.content_version := 1;
          new.version := 1;
        else
          new.updated_at := pg_catalog.now();
          if old.content is distinct from new.content then
            new.embedding := null;
            new.content_version := old.content_version + 1;
          else
            new.content_version := old.content_version;
          end if;
          if old.tree is distinct from new.tree
            or old.temporal is distinct from new.temporal
            or old.name is distinct from new.name
            or old.meta is distinct from new.meta
            or old.content is distinct from new.content
          then
            new.version := old.version + 1;
          else
            new.version := old.version;
            new.version_hash := old.version_hash;
            return new;
          end if;
        end if;

        new.version_hash := pg_catalog.md5(
          pg_catalog.jsonb_build_object(
            'tree', new.tree::text,
            'name', new.name,
            'meta', new.meta,
            'temporal', new.temporal::text,
            'content', new.content
          )::text
        );
        return new;
      end;
      $function$
    `,
    {
      spanName: "createRecordIntegrityFunction",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create function ${tx(context.schema)}.enqueue_record_embedding()
      returns trigger
      language plpgsql
      as $function$
      begin
        insert into ${tx(context.schema)}.embedding_queue
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
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create trigger record_integrity_before_write
      before insert or update on ${tx(context.schema)}.record
      for each row
      execute function ${tx(context.schema)}.record_integrity()
    `,
    {
      spanName: "createRecordIntegrityTrigger",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create trigger record_enqueue_after_insert
      after insert on ${tx(context.schema)}.record
      for each row
      execute function ${tx(context.schema)}.enqueue_record_embedding()
    `,
    {
      spanName: "createRecordInsertEnqueueTrigger",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
  await runSql(
    tx`
      create trigger record_enqueue_after_content_update
      after update of content on ${tx(context.schema)}.record
      for each row
      when (old.content is distinct from new.content)
      execute function ${tx(context.schema)}.enqueue_record_embedding()
    `,
    {
      spanName: "createRecordContentEnqueueTrigger",
      dbOperationName: "CREATE",
      namespace: context.schema,
    },
  );
}

function requireCreation(
  context: MigrationContext,
): NonNullable<MigrationContext["creation"]> {
  if (context.creation === null) {
    throw new Error("Initial DDL migrations require index creation parameters");
  }
  return context.creation;
}

function requireExtension(context: MigrationContext, name: string) {
  const extension = context.extensions.find(
    (candidate) => candidate.name === name,
  );
  if (!extension) {
    throw new Error(
      `Initial DDL migrations require extension ${JSON.stringify(name)}`,
    );
  }
  return extension;
}

async function validatedTextConfigLiteral(
  tx: postgres.TransactionSql,
  textConfig: string,
): Promise<string> {
  let row: { readonly literal: string } | undefined;
  try {
    [row] = await runSql(
      tx<{ readonly literal: string }[]>`
        select pg_catalog.quote_literal(c.oid::pg_catalog.regconfig::text) as literal
        from pg_catalog.pg_ts_config c
        where c.oid = ${textConfig}::pg_catalog.regconfig
      `,
      { spanName: "validateTextConfig", dbOperationName: "SELECT" },
    );
  } catch (error) {
    if (postgresErrorCode(error) !== "42704") {
      throw error;
    }
  }
  if (!row) {
    throw invalidTextConfig(textConfig);
  }
  return row.literal;
}

function invalidTextConfig(textConfig: string): InvalidConfigError {
  return new InvalidConfigError(
    `Unknown text search configuration: ${textConfig}`,
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
