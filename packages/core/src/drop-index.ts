import type postgres from "postgres";
import { readIndexMarker } from "./db/marker.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runSql } from "./sql/exec.ts";

/**
 * Drop a searchgres index and everything in its schema. Verifies the schema is
 * actually a searchgres index before dropping — it must carry the schema
 * comment `createIndex` stamps, the `version`/`record`/`embedding_queue`
 * tables, and a single format-version row — so an arbitrary caller schema
 * (even one that happens to own a table named `version`) can't be destroyed by
 * a mistyped name. Any schema-format version is droppable, so obsolete indexes
 * remain removable. The caller owns the pool; this never calls `sql.end()`.
 */
export async function dropIndex(
  sql: postgres.ISql,
  schema: string,
): Promise<void> {
  const indexSchema = assertSchemaName(schema);

  await readIndexMarker(sql, indexSchema);

  await runSql(sql`drop schema ${sql(indexSchema)} cascade`, {
    spanName: "dropIndexSchema",
    dbOperationName: "DROP",
    namespace: indexSchema,
  });
}
