import type postgres from "postgres";
import { InvalidIndexError } from "../errors.ts";
import { runSql } from "../sql/exec.ts";

/**
 * Comment stamped on every index schema by `createIndex`. It is the first
 * thing `openIndex`/`dropIndex` check, so a caller schema that merely happens
 * to contain a table named `version` is never mistaken for an index.
 */
export const INDEX_SCHEMA_COMMENT = "searchgres index";

/**
 * `INDEX_SCHEMA_COMMENT` as a single-quoted SQL literal for `COMMENT ON`,
 * which is a utility statement and cannot take bind parameters. The constant
 * contains no quote characters, so simple wrapping is a faithful literal.
 */
export const INDEX_SCHEMA_COMMENT_LITERAL = `'${INDEX_SCHEMA_COMMENT.replaceAll("'", "''")}'`;

interface MarkerRow {
  readonly schema_comment: string | null;
  readonly has_version_table: boolean;
  readonly has_version_column: boolean;
  readonly has_record_table: boolean;
  readonly has_queue_table: boolean;
}

interface VersionRow {
  readonly version: string;
}

/**
 * Verify that `schema` is a searchgres index and return its schema-format
 * version. Requires the `createIndex` schema comment, the `version`, `record`,
 * and `embedding_queue` tables, and exactly one non-empty `version` row.
 *
 * Any format version is accepted here; callers decide whether the format is
 * one they support (`openIndex`) or irrelevant (`dropIndex`, which must remain
 * able to remove obsolete indexes).
 */
export async function readIndexMarker(
  sql: postgres.ISql,
  schema: string,
): Promise<string> {
  const [marker] = await runSql(
    sql<MarkerRow[]>`
      select
        pg_catalog.obj_description(n.oid, 'pg_namespace') as schema_comment
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'version'
          and c.relkind = 'r'
        ) as has_version_table
      , exists (
          select 1
          from pg_catalog.pg_attribute a
          inner join pg_catalog.pg_class c on (c.oid = a.attrelid)
          where c.relnamespace = n.oid
          and c.relname = 'version'
          and c.relkind = 'r'
          and a.attname = 'version'
          and a.attnum > 0
          and not a.attisdropped
          and a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
        ) as has_version_column
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'record'
          and c.relkind = 'r'
        ) as has_record_table
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'embedding_queue'
          and c.relkind = 'r'
        ) as has_queue_table
      from pg_catalog.pg_namespace n
      where n.nspname = ${schema}
    `,
    { spanName: "readIndexMarker", dbOperationName: "SELECT" },
  );
  if (
    !marker ||
    marker.schema_comment !== INDEX_SCHEMA_COMMENT ||
    !marker.has_version_table ||
    !marker.has_version_column ||
    !marker.has_record_table ||
    !marker.has_queue_table
  ) {
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
  const version = rows.length === 1 ? rows[0]?.version : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new InvalidIndexError(schema);
  }
  return version;
}
