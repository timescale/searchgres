import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  ExtensionError,
  InvalidConfigError,
  InvalidIndexError,
  LockTimeoutError,
  RateLimitError,
  SchemaVersionError,
  SearchgresError,
  UnsupportedServerError,
} from "./errors.ts";

test("all typed errors retain a stable code, class name, and cause", () => {
  const cause = new Error("postgres said no");
  const error = new ConflictError("record already exists", { cause });

  assert.ok(error instanceof SearchgresError);
  assert.ok(error instanceof ConflictError);
  assert.equal(error.name, "ConflictError");
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.cause, cause);
});

test("errors retain the fields callers need to recover", () => {
  const invalid = new InvalidIndexError("docs");
  assert.equal(invalid.schema, "docs");

  const version = new SchemaVersionError("docs", "2", "1");
  assert.equal(version.schemaVersion, "2");
  assert.equal(version.supportedVersion, "1");

  const dimensions = new DimensionMismatchError(1536, 768);
  assert.equal(dimensions.expected, 1536);
  assert.equal(dimensions.actual, 768);

  const server = new UnsupportedServerError(170_000, 180_000);
  assert.equal(server.serverVersionNum, 170_000);
  assert.equal(server.minimumVersionNum, 180_000);

  const extension = new ExtensionError("vector", "0.8.0", "too_old", {
    foundVersion: "0.7.4",
  });
  assert.equal(extension.reason, "too_old");
  assert.equal(extension.foundVersion, "0.7.4");

  const lockTimeout = new LockTimeoutError();
  assert.equal(lockTimeout.code, "LOCK_TIMEOUT");

  const batch = new BatchTooLargeError(1001, 1000);
  assert.equal(batch.size, 1001);
  assert.equal(batch.maximum, 1000);

  const rateLimit = new RateLimitError("slow down", 2500);
  assert.equal(rateLimit.retryAfterMs, 2500);

  const config = new InvalidConfigError("invalid", {
    issues: [{ code: "custom", message: "bad value", path: ["bm25", "k1"] }],
  });
  assert.deepEqual(config.issues, [
    { code: "custom", message: "bad value", path: ["bm25", "k1"] },
  ]);
  assert.equal(Object.isFrozen(config.issues), true);
  assert.equal(Object.isFrozen(config.issues[0]?.path), true);
});
