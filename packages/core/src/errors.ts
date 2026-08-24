/** Stable machine-readable error codes exposed by searchgres. */
export type SearchgresErrorCode =
  | "BATCH_TOO_LARGE"
  | "CONFLICT"
  | "DIMENSION_MISMATCH"
  | "EMBEDDING_PROVIDER"
  | "INVALID_CONFIG"
  | "INVALID_INDEX"
  | "MIGRATION_FAILED"
  | "MIGRATION_REQUIRED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SCHEMA_VERSION"
  | "STALE_VERSION"
  | "TREE_PATH";

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

export class MigrationRequiredError extends SearchgresError {
  readonly schema: string;
  readonly pending: readonly string[];

  constructor(
    schema: string,
    pending: readonly string[],
    options?: ErrorOptions,
  ) {
    const detail = pending.length === 0 ? "unknown" : pending.join(", ");
    super(
      "MIGRATION_REQUIRED",
      `Index ${JSON.stringify(schema)} requires pending migrations: ${detail}`,
      options,
    );
    this.schema = schema;
    this.pending = Object.freeze([...pending]);
  }
}

export class SchemaVersionError extends SearchgresError {
  readonly schema: string;
  readonly libraryVersion: string;
  readonly minimumLibraryVersion: string;

  constructor(
    schema: string,
    libraryVersion: string,
    minimumLibraryVersion: string,
    options?: ErrorOptions,
  ) {
    super(
      "SCHEMA_VERSION",
      `Index ${JSON.stringify(schema)} requires searchgres >= ${minimumLibraryVersion}; running ${libraryVersion}`,
      options,
    );
    this.schema = schema;
    this.libraryVersion = libraryVersion;
    this.minimumLibraryVersion = minimumLibraryVersion;
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

  constructor(expected: number, actual: number, options?: ErrorOptions) {
    super(
      "DIMENSION_MISMATCH",
      `Embedding dimension mismatch: index expects ${expected}, received ${actual}`,
      options,
    );
    this.expected = expected;
    this.actual = actual;
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

export class MigrationError extends SearchgresError {
  readonly migration: string;

  constructor(migration: string, options?: ErrorOptions) {
    super(
      "MIGRATION_FAILED",
      `Migration ${JSON.stringify(migration)} failed`,
      options,
    );
    this.migration = migration;
  }
}
