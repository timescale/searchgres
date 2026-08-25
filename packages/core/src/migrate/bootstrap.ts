import type postgres from "postgres";
import { runSql } from "../sql/exec.ts";

/** Whether a PostgreSQL schema currently exists. */
export async function schemaExists(
  sql: postgres.ISql,
  schema: string,
): Promise<boolean> {
  const [row] = await runSql(
    sql<{ readonly present: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_namespace n
        where n.nspname = ${schema}
      ) as present
    `,
    { spanName: "schemaExists", dbOperationName: "SELECT" },
  );
  return row?.present ?? false;
}

/**
 * Provision the untracked schema marker and migration ledger for a new index.
 * The caller decides whether an existing schema is an error and owns the tx.
 */
export async function bootstrapIndex(
  tx: postgres.TransactionSql,
  schema: string,
): Promise<void> {
  await runSql(tx`create schema ${tx(schema)}`, {
    spanName: "bootstrapIndexSchema",
    dbOperationName: "CREATE",
    namespace: schema,
  });
  await runSql(
    tx`
      create table ${tx(schema)}.migration
      (
        name text primary key,
        applied_by_version text not null,
        min_library_version text not null,
        applied_at timestamptz not null default pg_catalog.clock_timestamp()
      )
    `,
    {
      spanName: "bootstrapMigrationLedger",
      dbOperationName: "CREATE",
      namespace: schema,
    },
  );
}
