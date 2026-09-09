import {
  InvalidInputError,
  LockTimeoutError,
  SearchgresError,
  StatementTimeoutError,
  TransactionTimeoutError,
} from "../errors.ts";

interface PostgresErrorLike {
  readonly code?: unknown;
  readonly message?: unknown;
}

/**
 * SQLSTATEs that, inside a searchgres routine call, can only be produced by
 * caller-supplied text. The statement text itself is fixed and tested, so a
 * syntax error is always the caller's `lquery`/`ltxtquery`/JSONPath pattern,
 * an invalid regular expression is the caller's `regexp`, and
 * `invalid_parameter_value` is one of the routines' own `raise` statements.
 */
const INPUT_SQLSTATES: Readonly<Record<string, string>> = {
  "22023": "invalid parameter value",
  "22P02": "invalid text representation",
  "2201B": "invalid regular expression",
  "42601": "syntax error",
};

/** Return a PostgreSQL SQLSTATE when the thrown value carries one. */
export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as PostgresErrorLike).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Map a PostgreSQL failure caused by caller-supplied input to a typed
 * `InvalidInputError`, or return `undefined` when the SQLSTATE is not one of
 * the input-attributable set. `subject` names the operation for the message
 * ("search", "patch", ...). The driver error is preserved as `cause`, and the
 * single issue carries the SQLSTATE as its `code` so callers can distinguish
 * a bad pattern from a routine-level validation `raise`.
 */
export function mapInputSqlError(
  error: unknown,
  subject: string,
): InvalidInputError | undefined {
  const code = postgresErrorCode(error);
  if (code === undefined || !(code in INPUT_SQLSTATES)) {
    return undefined;
  }
  const raw = (error as PostgresErrorLike).message;
  const detail =
    typeof raw === "string" && raw.length > 0 ? raw : INPUT_SQLSTATES[code];
  return new InvalidInputError(`Invalid ${subject}: ${detail}`, {
    cause: error,
    issues: [{ code, message: detail ?? code, path: [] }],
  });
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
