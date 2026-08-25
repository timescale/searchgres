import {
  LockTimeoutError,
  SearchgresError,
  StatementTimeoutError,
  TransactionTimeoutError,
} from "../errors.ts";

interface PostgresErrorLike {
  readonly code?: unknown;
}

/** Return a PostgreSQL SQLSTATE when the thrown value carries one. */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as PostgresErrorLike).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Translate SQLSTATEs whose meaning does not depend on the statement being run.
 * Constraint and validation failures are intentionally mapped by their callers.
 */
export function mapSqlError(error: unknown): unknown {
  if (error instanceof SearchgresError) {
    return error;
  }

  switch (postgresErrorCode(error)) {
    case "57014":
      return new StatementTimeoutError(undefined, { cause: error });
    case "55P03":
      return new LockTimeoutError(undefined, { cause: error });
    case "25P04":
      return new TransactionTimeoutError(undefined, { cause: error });
    default:
      return error;
  }
}
