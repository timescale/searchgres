# Errors and recovery

Every error searchgres raises extends `SearchgresError` and carries a stable
`code`. Catch the base class to detect any searchgres error, or a specific
subclass to handle one case:

```ts
import { SearchgresError, StaleVersionError } from "searchgres";

try {
  await index.patch(id, versionHash, { content });
} catch (error) {
  if (error instanceof StaleVersionError) {
    // re-read and retry
  } else if (error instanceof SearchgresError) {
    // any other searchgres error
  } else {
    throw error;
  }
}
```

Each error also exposes a machine-readable `code` (e.g. `"STALE_VERSION"`) and,
where useful, extra fields described below.

## Input and configuration

### `InvalidConfigError` (`INVALID_CONFIG`)

Invalid input to a public function — a bad index config, a malformed record, an
invalid patch, or a bad search option. Carries `issues`, a list of structured
validation problems.

**Recover:** fix the input. These are programming errors, not runtime
conditions.

### `TreePathError` (`TREE_PATH`)

A concrete tree path is not a valid dotted `ltree` (each label must be
`[A-Za-z0-9_-]+`). Carries `path`.

**Recover:** correct the path. Note that `lquery`/`ltxtquery` **patterns** are
not validated this way — they pass through to PostgreSQL.

### `DimensionMismatchError` (`DIMENSION_MISMATCH`)

A vector's length doesn't match the index. Carries `expected`, `actual`, and (for
batch writes) `position`. Thrown for a supplied embedding of the wrong length, or
when your embedding model returns vectors of a different size than the index was
created with.

**Recover:** ensure `createIndex({ dimensions })` matches your model's output;
re-embed if you changed models.

## Conflicts and versions

### `ConflictError` (`CONFLICT`)

A uniqueness conflict: creating an index schema that exists, an `onConflict:
"error"` write hitting an existing key, or a move/copy/patch landing on an
occupied `(tree, name)` slot.

**Recover:** for writes, choose `ignore` or `replace`; for renames/moves, pick a
free name or remove the occupant first.

### `StaleVersionError` (`STALE_VERSION`)

A `patch` whose `priorVersionHash` no longer matches — the record changed since
you read it. Carries `id`.

**Recover:** re-read the record and retry with the fresh `versionHash`.

### `NotFoundError` (`NOT_FOUND`)

A `get`, `getByName`, `patch`, `delete`, or `deleteByName` addressed a record that
doesn't exist. Carries `target`.

**Recover:** confirm the id or `(tree, name)`. Subtree operations do **not** throw
this — an empty subtree returns a count of 0.

### `BatchTooLargeError` (`BATCH_TOO_LARGE`)

`upsertMany` was given more than 1,000 records. Carries `size` and `maximum`.

**Recover:** split the input into chunks of 1,000 or fewer.

## Embeddings

### `RateLimitError` (`RATE_LIMITED`)

The embedding provider returned HTTP 429. Carries `retryAfterMs` when the
provider supplied it. During a drain, the claimed rows are released and their
attempts refunded before this is thrown, so no work is lost.

**Recover:** back off (honoring `retryAfterMs`) and drain again. A continuous
worker handles this for you.

### `EmbeddingProviderError` (`EMBEDDING_PROVIDER`)

The embedding provider failed for a non-rate-limit reason. The original error is
on `cause`.

**Recover:** inspect `cause`; fix credentials/connectivity and retry.

## Provisioning and environment

### `ExtensionError` (`EXTENSION`)

A required extension is missing, too old, unavailable, or installed outside
`public`. Carries `extension`, `minimumVersion`, `foundVersion`, and `reason`
(`"missing" | "too_old" | "unavailable" | "permission_denied" |
"wrong_schema"`).

**Recover:** install/upgrade the extension in `public`, or grant the connecting
role `CREATE EXTENSION`. See [Install searchgres](../installation.md).

### `UnsupportedServerError` (`UNSUPPORTED_SERVER`)

The PostgreSQL server is older than searchgres supports. Carries
`serverVersionNum` and `minimumVersionNum`.

**Recover:** use PostgreSQL 18 or newer.

### `InvalidIndexError` (`INVALID_INDEX`)

`openIndex`/`dropIndex` targeted a schema that isn't a searchgres index (no valid
version marker or the expected shape is missing). Carries `schema`.

**Recover:** check the schema name, or create the index first.

### `SchemaVersionError` (`SCHEMA_VERSION`)

The index was created by an incompatible searchgres schema format. Carries
`schema`, `schemaVersion`, and `supportedVersion`.

**Recover:** create a new index and reindex; there is no in-place upgrade. See
[Rebuild and cut over](../guides/indexes.md#rebuild-and-cut-over).

## Database timeouts

Raised when a statement, lock wait, or transaction exceeds its timeout:

- `StatementTimeoutError` (`STATEMENT_TIMEOUT`)
- `LockTimeoutError` (`LOCK_TIMEOUT`)
- `TransactionTimeoutError` (`TRANSACTION_TIMEOUT`)

**Recover:** retry, and investigate contention or long-running work if they
persist.
