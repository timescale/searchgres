import type postgres from "postgres";
import { runSql } from "../sql/exec.ts";

export interface SessionTimeouts {
  readonly statementTimeout: string;
  readonly lockTimeout: string;
  readonly transactionTimeout: string;
  readonly idleInTransactionSessionTimeout: string;
}

export const DEFAULT_MIGRATION_LOCK_TIMEOUT = "30s";

export const DEFAULT_MIGRATION_TIMEOUTS: Readonly<SessionTimeouts> =
  Object.freeze({
    statementTimeout: "0",
    lockTimeout: "5s",
    transactionTimeout: "20min",
    idleInTransactionSessionTimeout: "5s",
  });

/** Apply transaction-local timeouts through bound values rather than SQL text. */
export async function applySessionTimeouts(
  sql: postgres.ISql,
  timeouts: SessionTimeouts,
): Promise<void> {
  await runSql(
    sql`
      select
        pg_catalog.set_config('statement_timeout', ${timeouts.statementTimeout}, true),
        pg_catalog.set_config('lock_timeout', ${timeouts.lockTimeout}, true),
        pg_catalog.set_config('transaction_timeout', ${timeouts.transactionTimeout}, true),
        pg_catalog.set_config(
          'idle_in_transaction_session_timeout',
          ${timeouts.idleInTransactionSessionTimeout},
          true
        )
    `,
    { spanName: "applySessionTimeouts", dbOperationName: "SELECT" },
  );
}

/** Change only the transaction-local object-lock timeout after advisory locking. */
export async function setLockTimeout(
  sql: postgres.ISql,
  lockTimeout: string,
): Promise<void> {
  await runSql(
    sql`select pg_catalog.set_config('lock_timeout', ${lockTimeout}, true)`,
    { spanName: "setLockTimeout", dbOperationName: "SELECT" },
  );
}
