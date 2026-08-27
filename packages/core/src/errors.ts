/** Stable machine-readable error codes exposed by searchgres. */
export type SearchgresErrorCode =
  | "BATCH_TOO_LARGE"
  | "CONFLICT"
  | "DIMENSION_MISMATCH"
  | "EMBEDDING_PROVIDER"
  | "EXTENSION"
  | "INVALID_CONFIG"
  | "INVALID_INDEX"
  | "LOCK_TIMEOUT"
  | "NOT_FOUND"
  | "STATEMENT_TIMEOUT"
  | "RATE_LIMITED"
  | "SCHEMA_VERSION"
  | "STALE_VERSION"
  | "TRANSACTION_TIMEOUT"
  | "TREE_PATH"
  | "UNSUPPORTED_SERVER";

/** Validator-neutral issue shape retained on typed validation errors. */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (number | string)[];
}

/** Base class for every error intentionally raised by searchgres. */
export class SearchgresError extends Error {
  readonly code: SearchgresErrorCode;

  constructor(
    code: SearchgresErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidIndexError extends SearchgresError {
  readonly schema: string;

  constructor(schema: string, options?: ErrorOptions) {
    super(
      "INVALID_INDEX",
      `Schema ${JSON.stringify(schema)} is not a searchgres index`,
      options,
    );
    this.schema = schema;
  }
}

export class SchemaVersionError extends SearchgresError {
  readonly schema: string;
  readonly schemaVersion: string;
  readonly supportedVersion: string;

  constructor(
    schema: string,
    schemaVersion: string,
    supportedVersion: string,
    options?: ErrorOptions,
  ) {
    super(
      "SCHEMA_VERSION",
      `Index ${JSON.stringify(schema)} uses schema format ${schemaVersion}; this library supports ${supportedVersion}. Create a new index and reindex.`,
      options,
    );
    this.schema = schema;
    this.schemaVersion = schemaVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class InvalidConfigError extends SearchgresError {
  readonly issues: readonly ValidationIssue[];

  constructor(
    message: string,
    options?: ErrorOptions & { readonly issues?: readonly ValidationIssue[] },
  ) {
    super("INVALID_CONFIG", message, options);
    this.issues = Object.freeze(
      (options?.issues ?? []).map((issue) =>
        Object.freeze({
          code: issue.code,
          message: issue.message,
          path: Object.freeze([...issue.path]),
        }),
      ),
    );
  }
}

export class TreePathError extends SearchgresError {
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super("TREE_PATH", message, options);
    this.path = path;
  }
}

export class DimensionMismatchError extends SearchgresError {
  readonly expected: number;
  readonly actual: number;
  /** Zero-based index of the offending record within a batch write. */
  readonly position: number | undefined;

  constructor(
    expected: number,
    actual: number,
    options?: ErrorOptions & { readonly position?: number },
  ) {
    const position = options?.position;
    const at = position === undefined ? "" : ` at record ${position}`;
    super(
      "DIMENSION_MISMATCH",
      `Embedding dimension mismatch${at}: index expects ${expected}, received ${actual}`,
      options,
    );
    this.expected = expected;
    this.actual = actual;
    this.position = position;
  }
}

export class UnsupportedServerError extends SearchgresError {
  readonly serverVersionNum: number;
  readonly minimumVersionNum: number;

  constructor(
    serverVersionNum: number,
    minimumVersionNum: number,
    options?: ErrorOptions,
  ) {
    super(
      "UNSUPPORTED_SERVER",
      `PostgreSQL ${minimumVersionNum} or newer is required; server reports ${serverVersionNum}`,
      options,
    );
    this.serverVersionNum = serverVersionNum;
    this.minimumVersionNum = minimumVersionNum;
  }
}

export type ExtensionErrorReason =
  | "missing"
  | "permission_denied"
  | "too_old"
  | "unavailable"
  | "wrong_schema";

export class ExtensionError extends SearchgresError {
  readonly extension: string;
  readonly minimumVersion: string;
  readonly foundVersion: string | null;
  readonly reason: ExtensionErrorReason;

  constructor(
    extension: string,
    minimumVersion: string,
    reason: ExtensionErrorReason,
    options?: ErrorOptions & { readonly foundVersion?: string | null },
  ) {
    const foundVersion = options?.foundVersion ?? null;
    const detail = foundVersion ? `; found ${foundVersion}` : "";
    const guidance =
      reason === "permission_denied"
        ? "; install it before connecting or grant CREATE EXTENSION"
        : reason === "wrong_schema"
          ? "; searchgres requires it in the public schema"
          : "";
    super(
      "EXTENSION",
      `PostgreSQL extension ${JSON.stringify(extension)} >= ${minimumVersion} is required (${reason}${detail}${guidance})`,
      options,
    );
    this.extension = extension;
    this.minimumVersion = minimumVersion;
    this.foundVersion = foundVersion;
    this.reason = reason;
  }
}

export class StatementTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL statement timed out",
    options?: ErrorOptions,
  ) {
    super("STATEMENT_TIMEOUT", message, options);
  }
}

export class LockTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL lock wait timed out",
    options?: ErrorOptions,
  ) {
    super("LOCK_TIMEOUT", message, options);
  }
}

export class TransactionTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL transaction timed out",
    options?: ErrorOptions,
  ) {
    super("TRANSACTION_TIMEOUT", message, options);
  }
}

export class NotFoundError extends SearchgresError {
  /** The id or human-readable `(tree, name)` address that was requested. */
  readonly target: string;

  constructor(target: string, options?: ErrorOptions) {
    super(
      "NOT_FOUND",
      `Record ${JSON.stringify(target)} was not found`,
      options,
    );
    this.target = target;
  }
}

export class StaleVersionError extends SearchgresError {
  readonly id: string;

  constructor(id: string, options?: ErrorOptions) {
    super(
      "STALE_VERSION",
      `Record ${JSON.stringify(id)} has changed since it was read`,
      options,
    );
    this.id = id;
  }
}

export class ConflictError extends SearchgresError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFLICT", message, options);
  }
}

export class BatchTooLargeError extends SearchgresError {
  readonly size: number;
  readonly maximum: number;

  constructor(size: number, maximum: number, options?: ErrorOptions) {
    super(
      "BATCH_TOO_LARGE",
      `Batch contains ${size} records; the maximum is ${maximum}`,
      options,
    );
    this.size = size;
    this.maximum = maximum;
  }
}

export class EmbeddingProviderError extends SearchgresError {
  constructor(message: string, options?: ErrorOptions) {
    super("EMBEDDING_PROVIDER", message, options);
  }
}

export class RateLimitError extends SearchgresError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message = "Embedding provider rate limit exceeded",
    retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super("RATE_LIMITED", message, options);
    this.retryAfterMs = retryAfterMs;
  }
}
