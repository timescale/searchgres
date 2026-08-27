import type { EmbeddingModel } from "ai";
import type postgres from "postgres";
import { SCHEMA_FORMAT_VERSION } from "./create-index.ts";
import { getExtensionInfo } from "./db/extensions.ts";
import { InvalidIndexError, SchemaVersionError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runSql } from "./sql/exec.ts";
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

export interface OpenIndexOptions {
  readonly embedding: EmbeddingModel;
}

export class Index {
  readonly schema: string;
  readonly vectorType: "vector" | "halfvec";
  readonly dimensions: number;
  readonly embedding: EmbeddingModel;

  /** @internal Caller-owned pool used by query and worker methods. */
  readonly sql: postgres.Sql;

  constructor(options: {
    sql: postgres.Sql;
    schema: string;
    vectorType: "vector" | "halfvec";
    dimensions: number;
    embedding: EmbeddingModel;
  }) {
    this.sql = options.sql;
    this.schema = options.schema;
    this.vectorType = options.vectorType;
    this.dimensions = options.dimensions;
    this.embedding = options.embedding;
  }

  /** Insert one record, or resolve a conflict according to `options`. */
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
