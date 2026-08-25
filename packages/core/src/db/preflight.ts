import type postgres from "postgres";
import { UnsupportedServerError } from "../errors.ts";
import { runSql } from "../sql/exec.ts";

export const MINIMUM_POSTGRES_VERSION_NUM = 180_000;

interface VersionRow {
  readonly server_version_num: string;
}

/** Ensure the connected database is PostgreSQL 18 or newer. */
export async function ensurePostgresVersion(
  sql: postgres.ISql,
): Promise<number> {
  const [row] = await runSql(
    sql<VersionRow[]>`
      select pg_catalog.current_setting('server_version_num') as server_version_num
    `,
    { spanName: "ensurePostgresVersion", dbOperationName: "SELECT" },
  );
  const serverVersionNum = Number(row?.server_version_num);
  if (
    !Number.isSafeInteger(serverVersionNum) ||
    serverVersionNum < MINIMUM_POSTGRES_VERSION_NUM
  ) {
    throw new UnsupportedServerError(
      serverVersionNum,
      MINIMUM_POSTGRES_VERSION_NUM,
    );
  }
  return serverVersionNum;
}
