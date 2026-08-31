import type { EmbeddingModel } from "ai";
import type postgres from "postgres";
import { SCHEMA_FORMAT_VERSION } from "./create-index.ts";
import {
  pruneQueue,
  type QueueStats,
  queueStats,
} from "./db/embedding-queue.ts";
import { getExtensionInfo } from "./db/extensions.ts";
import { dropIndex } from "./drop-index.ts";
import {
  type EmbeddingWorker,
  type EmbeddingWorkerOptions,
  type ProcessEmbeddingsOptions,
  type ProcessEmbeddingsResult,
  processEmbeddings,
  startEmbeddingWorker,
} from "./embedding-worker.ts";
import { InvalidIndexError, SchemaVersionError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import {
  deleteByName,
  deleteRecord,
  get,
  getByName,
  type PatchInput,
  patch,
  type StoredRecord,
} from "./records.ts";
import { type SearchOptions, type SearchResult, search } from "./search.ts";
import { runSql } from "./sql/exec.ts";
import {
  copyTree,
  countTree,
  deleteTree,
  listTree,
  moveTree,
  type TreeCountOptions,
  type TreeCountResult,
  type TreeCountSelector,
  type TreeListEntry,
  type TreeMutationOptions,
  type TreeMutationResult,
} from "./tree.ts";
import { noTruncation, type Truncator } from "./truncate.ts";
import {
  type UpsertOptions,
  type UpsertRecord,
  type UpsertResult,
  upsertMany,
} from "./write.ts";

const REQUIRED_EXTENSIONS = [
  { name: "vector", minimumVersion: "0.8.0" },
  { name: "pg_textsearch", minimumVersion: "1.4.0" },
  { name: "ltree", minimumVersion: "1.3.0" },
] as const;

/**
 * The subset of {@link Index} that is safe to compose inside one caller-owned
 * transaction: record and tree operations only. Embedding-drain and queue
 * maintenance are intentionally excluded — the worker owns multiple short
 * transactions around remote provider calls and must not run inside (or outlive)
 * a caller transaction. Obtained via {@link Index.with}.
 */
export interface TransactionIndex {
  /** Insert one record, replacing a conflict by default. */
  upsert(record: UpsertRecord, options?: UpsertOptions): Promise<UpsertResult>;
  /** Insert records, replacing conflicts by default. */
  upsertMany(
    records: readonly UpsertRecord[],
    options?: UpsertOptions,
  ): Promise<readonly UpsertResult[]>;
  /** Insert one record and throw {@link ConflictError} if it already exists. */
  insert(record: UpsertRecord): Promise<UpsertResult>;
  /** Insert records and throw {@link ConflictError} if any already exist. */
  insertMany(
    records: readonly UpsertRecord[],
  ): Promise<readonly UpsertResult[]>;
  search(options?: SearchOptions): Promise<readonly SearchResult[]>;
  get(id: string): Promise<StoredRecord>;
  getByName(tree: string, name: string): Promise<StoredRecord>;
  patch(
    id: string,
    priorVersionHash: string,
    input: PatchInput,
  ): Promise<StoredRecord>;
  delete(id: string): Promise<void>;
  deleteByName(tree: string, name: string): Promise<void>;
  moveTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  copyTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  deleteTree(
    tree: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  countTree(
    selector: TreeCountSelector,
    options?: TreeCountOptions,
  ): Promise<TreeCountResult>;
  listTree(lquery: string): Promise<readonly TreeListEntry[]>;
}

export interface OpenIndexOptions {
  readonly embedding: EmbeddingModel;
  /**
   * Applied to record content (by the worker) and to `semantic` query text
   * before embedding. Runtime policy only — not persisted. Defaults to
   * {@link noTruncation}.
   */
  readonly truncate?: Truncator;
}

export class Index implements TransactionIndex {
  readonly schema: string;
  readonly vectorType: "vector" | "halfvec";
  readonly dimensions: number;
  readonly embedding: EmbeddingModel;
  readonly truncate: Truncator;

  /** @internal Caller-owned pool or transaction used by every method. */
  readonly sql: postgres.Sql;

  constructor(options: {
    sql: postgres.Sql;
    schema: string;
    vectorType: "vector" | "halfvec";
    dimensions: number;
    embedding: EmbeddingModel;
    truncate: Truncator;
  }) {
    this.sql = options.sql;
    this.schema = options.schema;
    this.vectorType = options.vectorType;
    this.dimensions = options.dimensions;
    this.embedding = options.embedding;
    this.truncate = options.truncate;
  }

  /** Insert one record, replacing a conflict by default. */
  async upsert(
    record: UpsertRecord,
    options?: UpsertOptions,
  ): Promise<UpsertResult> {
    const [result] = await this.upsertMany([record], options);
    if (!result) {
      throw new Error("Upsert result invariant failed: expected one record");
    }
    return result;
  }

  /** Insert or replace up to 1,000 records in one bulk SQL statement. */
  async upsertMany(
    records: readonly UpsertRecord[],
    options?: UpsertOptions,
  ): Promise<readonly UpsertResult[]> {
    return upsertMany(this, records, options);
  }

  /** Insert one record and throw {@link ConflictError} if it already exists. */
  async insert(record: UpsertRecord): Promise<UpsertResult> {
    return this.upsert(record, { onConflict: "error" });
  }

  /** Insert records and throw {@link ConflictError} if any already exist. */
  async insertMany(
    records: readonly UpsertRecord[],
  ): Promise<readonly UpsertResult[]> {
    return this.upsertMany(records, { onConflict: "error" });
  }

  /**
   * Search the index. The retrieval mode is inferred from the supplied arms:
   * `semantic`/`vector` only, `fulltext` only, both (hybrid RRF), or neither
   * (filter-only listing).
   */
  async search(options?: SearchOptions): Promise<readonly SearchResult[]> {
    return search(this, options ?? {});
  }

  /** Read one record by id. Throws `NotFoundError` when it does not exist. */
  async get(id: string): Promise<StoredRecord> {
    return get(this, id);
  }

  /** Read one record by its `(tree, name)` address. Throws `NotFoundError`. */
  async getByName(tree: string, name: string): Promise<StoredRecord> {
    return getByName(this, tree, name);
  }

  /**
   * Optimistically update a record. `priorVersionHash` must match the current
   * row: a missing row throws `NotFoundError`, a changed row `StaleVersionError`.
   * Returns the updated record.
   */
  async patch(
    id: string,
    priorVersionHash: string,
    input: PatchInput,
  ): Promise<StoredRecord> {
    return patch(this, id, priorVersionHash, input);
  }

  /** Delete one record by id. Throws `NotFoundError` when it does not exist. */
  async delete(id: string): Promise<void> {
    return deleteRecord(this, id);
  }

  /** Delete one record by its `(tree, name)` address. Throws `NotFoundError`. */
  async deleteByName(tree: string, name: string): Promise<void> {
    return deleteByName(this, tree, name);
  }

  /** Move a subtree: rewrite the `source` prefix to `destination`. */
  async moveTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return moveTree(this, source, destination, options);
  }

  /** Copy a subtree under `destination` as fresh records. */
  async copyTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return copyTree(this, source, destination, options);
  }

  /** Delete an inclusive subtree. */
  async deleteTree(
    tree: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return deleteTree(this, tree, options);
  }

  /** Count records matching one explicit tree filter kind. */
  async countTree(
    selector: TreeCountSelector,
    options?: TreeCountOptions,
  ): Promise<TreeCountResult> {
    return countTree(this, selector, options);
  }

  /** List the tree nodes matching an lquery with per-node descendant counts. */
  async listTree(lquery: string): Promise<readonly TreeListEntry[]> {
    return listTree(this, lquery);
  }

  /**
   * Drain pending embedding work in one bounded pass and return the outcome.
   * For cron, post-bulk-ingest, or a serverless invocation. Concurrency-safe
   * with other drainers via `for update skip locked`.
   */
  async processEmbeddings(
    options?: ProcessEmbeddingsOptions,
  ): Promise<ProcessEmbeddingsResult> {
    return processEmbeddings(this, options);
  }

  /**
   * Start a continuous background drainer. Returns a handle whose `stop()`
   * finishes the in-flight batch and halts; it never closes the caller's pool.
   */
  startEmbeddingWorker(options?: EmbeddingWorkerOptions): EmbeddingWorker {
    return startEmbeddingWorker(this, options);
  }

  /** Aggregate embedding-queue snapshot for operational visibility. */
  async queueStats(): Promise<QueueStats> {
    return queueStats(this.sql, this.schema);
  }

  /** Delete terminal queue rows older than `retentionMs`. Returns rows removed. */
  async pruneEmbeddingQueue(options: {
    readonly retentionMs: number;
  }): Promise<number> {
    return pruneQueue(this.sql, this.schema, options.retentionMs);
  }

  /**
   * Bind record/tree operations to a caller-owned transaction so they compose
   * atomically. A no-I/O clone; the caller owns commit/rollback and the pool.
   * Embedding-drain and queue methods are intentionally not exposed here.
   */
  with(tx: postgres.TransactionSql): TransactionIndex {
    return new Index({
      // A TransactionSql is a query runner just like Sql (minus pool lifecycle,
      // which the handle never calls); the cast keeps the field type simple.
      sql: tx as unknown as postgres.Sql,
      schema: this.schema,
      vectorType: this.vectorType,
      dimensions: this.dimensions,
      embedding: this.embedding,
      truncate: this.truncate,
    });
  }

  /** Drop this index's schema and everything in it (`drop schema … cascade`). */
  async drop(): Promise<void> {
    return dropIndex(this.sql, this.schema);
  }
}

interface VersionRow {
  readonly version: string;
}

interface EmbeddingColumnRow {
  readonly type_name: string;
  readonly type_schema: string;
  readonly display_type: string;
}

interface HnswOpclassRow {
  readonly opcname: string;
  readonly opclass_schema: string;
  readonly amname: string;
}

/** Open and validate an immutable searchgres index without running DDL. */
export async function openIndex(
  sql: postgres.Sql,
  schema: string,
  options: OpenIndexOptions,
): Promise<Index> {
  const indexSchema = assertSchemaName(schema);
  const version = await readSchemaVersion(sql, indexSchema);
  if (version !== SCHEMA_FORMAT_VERSION) {
    throw new SchemaVersionError(indexSchema, version, SCHEMA_FORMAT_VERSION);
  }

  // searchgres is public-only: every required extension must be installed in
  // `public`, and the index objects must resolve to it.
  for (const requirement of REQUIRED_EXTENSIONS) {
    await getExtensionInfo(sql, requirement);
  }

  const embedding = await readEmbeddingColumn(sql, indexSchema);
  if (embedding.type_schema !== "public") {
    throw new InvalidIndexError(indexSchema);
  }
  const vectorShape = parseVectorShape(embedding, indexSchema);
  const hnswOpclass = await readHnswOpclass(sql, indexSchema);
  if (
    hnswOpclass.amname !== "hnsw" ||
    hnswOpclass.opclass_schema !== "public" ||
    hnswOpclass.opcname !== `${vectorShape.vectorType}_cosine_ops`
  ) {
    throw new InvalidIndexError(indexSchema);
  }

  return new Index({
    sql,
    schema: indexSchema,
    vectorType: vectorShape.vectorType,
    dimensions: vectorShape.dimensions,
    embedding: options.embedding,
    truncate: options.truncate ?? noTruncation,
  });
}

async function readSchemaVersion(
  sql: postgres.Sql,
  schema: string,
): Promise<string> {
  const [marker] = await runSql(
    sql<{ readonly present: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_class c
        inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
        where n.nspname = ${schema}
        and c.relname = 'version'
        and c.relkind = 'r'
      ) as present
    `,
    { spanName: "readSchemaVersionMarker", dbOperationName: "SELECT" },
  );
  if (!marker?.present) {
    throw new InvalidIndexError(schema);
  }

  const rows = await runSql(
    sql<VersionRow[]>`
      select version
      from ${sql(schema)}.version
    `,
    {
      spanName: "readSchemaVersion",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (rows.length !== 1 || !rows[0]) {
    throw new InvalidIndexError(schema);
  }
  return rows[0].version;
}

async function readEmbeddingColumn(
  sql: postgres.Sql,
  schema: string,
): Promise<EmbeddingColumnRow> {
  const [row] = await runSql(
    sql<EmbeddingColumnRow[]>`
      select
        t.typname as type_name
      , tn.nspname as type_schema
      , pg_catalog.format_type(a.atttypid, a.atttypmod) as display_type
      from pg_catalog.pg_attribute a
      inner join pg_catalog.pg_class c on (c.oid = a.attrelid)
      inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
      inner join pg_catalog.pg_type t on (t.oid = a.atttypid)
      inner join pg_catalog.pg_namespace tn on (tn.oid = t.typnamespace)
      where n.nspname = ${schema}
      and c.relname = 'record'
      and a.attname = 'embedding'
      and not a.attisdropped
    `,
    {
      spanName: "readEmbeddingColumn",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (!row) {
    throw new InvalidIndexError(schema);
  }
  return row;
}

function parseVectorShape(
  column: EmbeddingColumnRow,
  schema: string,
): { readonly vectorType: "vector" | "halfvec"; readonly dimensions: number } {
  if (column.type_name !== "vector" && column.type_name !== "halfvec") {
    throw new InvalidIndexError(schema);
  }
  const dimensions = /\((\d+)\)$/.exec(column.display_type)?.[1];
  if (!dimensions) {
    throw new InvalidIndexError(schema);
  }
  return {
    vectorType: column.type_name,
    dimensions: Number(dimensions),
  };
}

async function readHnswOpclass(
  sql: postgres.Sql,
  schema: string,
): Promise<HnswOpclassRow> {
  const [row] = await runSql(
    sql<HnswOpclassRow[]>`
      select
        opc.opcname
      , opn.nspname as opclass_schema
      , am.amname
      from pg_catalog.pg_index i
      inner join pg_catalog.pg_class c on (c.oid = i.indexrelid)
      inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
      inner join pg_catalog.pg_opclass opc on (opc.oid = i.indclass[0])
      inner join pg_catalog.pg_namespace opn on (opn.oid = opc.opcnamespace)
      inner join pg_catalog.pg_am am on (am.oid = opc.opcmethod)
      where n.nspname = ${schema}
      and c.relname = 'record_embedding_hnsw_idx'
    `,
    {
      spanName: "readHnswOpclass",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (!row) {
    throw new InvalidIndexError(schema);
  }
  return row;
}
