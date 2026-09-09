import type postgres from "postgres";
import { UnsupportedServerError } from "../errors.ts";
import { runSql } from "../sql/exec.ts";

export const MINIMUM_POSTGRES_VERSION_NUM = 180_000;

interface VersionRow {
  readonly server_version_num: string | null;
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
  const reported = row?.server_version_num;
  const serverVersionNum = reported === null ? Number.NaN : Number(reported);
  if (!Number.isSafeInteger(serverVersionNum)) {
    // Unreachable against real PostgreSQL (server_version_num is always set),
    // but a proxy or a mock could return nothing; say so rather than
    // "server reports NaN".
    throw new UnsupportedServerError(
      serverVersionNum,
      MINIMUM_POSTGRES_VERSION_NUM,
      {
        cause: new Error(
          `server_version_num was ${reported === undefined ? "not returned" : JSON.stringify(reported)}`,
        ),
      },
    );
  }
  if (serverVersionNum < MINIMUM_POSTGRES_VERSION_NUM) {
    throw new UnsupportedServerError(
      serverVersionNum,
      MINIMUM_POSTGRES_VERSION_NUM,
    );
  }
  return serverVersionNum;
}
