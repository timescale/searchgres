import type postgres from "postgres";
import { InvalidIndexError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runSql } from "./sql/exec.ts";

/**
 * Drop a searchgres index and everything in its schema. Verifies the schema is
 * actually a searchgres index (its singleton `version` marker is present) before
 * dropping, so an arbitrary caller schema can't be destroyed by a mistyped name.
 * Any schema-format version is droppable, so obsolete indexes remain removable.
 * The caller owns the pool; this never calls `sql.end()`.
 */
export async function dropIndex(
  sql: postgres.Sql,
  schema: string,
): Promise<void> {
  const indexSchema = assertSchemaName(schema);

  const [marker] = await runSql(
    sql<{ readonly present: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_class c
        inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
        where n.nspname = ${indexSchema}
        and c.relname = 'version'
        and c.relkind = 'r'
      ) as present
    `,
    { spanName: "dropIndexVerifyMarker", dbOperationName: "SELECT" },
  );
  if (!marker?.present) {
    throw new InvalidIndexError(indexSchema);
  }

  await runSql(sql`drop schema ${sql(indexSchema)} cascade`, {
    spanName: "dropIndexSchema",
    dbOperationName: "DROP",
    namespace: indexSchema,
  });
}
