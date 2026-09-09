import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidInputError,
  LockTimeoutError,
  StatementTimeoutError,
  TransactionTimeoutError,
} from "../errors.ts";
import { mapInputSqlError, mapSqlError, postgresErrorCode } from "./errors.ts";

test("maps context-free PostgreSQL timeout SQLSTATEs", () => {
  const cause = Object.assign(new Error("timeout"), { code: "57014" });
  const mapped = mapSqlError(cause);
  assert.ok(mapped instanceof StatementTimeoutError);
  assert.equal(mapped.cause, cause);

  assert.ok(
    mapSqlError(Object.assign(new Error("lock"), { code: "55P03" })) instanceof
      LockTimeoutError,
  );
  assert.ok(
    mapSqlError(
      Object.assign(new Error("transaction"), { code: "25P04" }),
    ) instanceof TransactionTimeoutError,
  );
});

test("leaves context-dependent SQLSTATEs for the caller", () => {
  const conflict = Object.assign(new Error("unique"), { code: "23505" });
  assert.equal(mapSqlError(conflict), conflict);
  assert.equal(postgresErrorCode(conflict), "23505");
  assert.equal(postgresErrorCode(new Error("no code")), undefined);
});

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

test("mapInputSqlError wraps input-attributable SQLSTATEs", () => {
  for (const [code, message] of [
    ["42601", "lquery syntax error at character 5"],
    ["2201B", "invalid regular expression: parentheses () not balanced"],
    ["22023", "unknown filter key: bogus"],
    ["22P02", "invalid input syntax for type uuid"],
  ] as const) {
    const cause = pgError(code, message);
    const mapped = mapInputSqlError(cause, "search input");
    assert.ok(mapped instanceof InvalidInputError, code);
    assert.equal(mapped.code, "INVALID_INPUT");
    assert.equal(mapped.message, `Invalid search input: ${message}`);
    assert.equal(mapped.cause, cause);
    assert.deepEqual(mapped.issues, [{ code, message, path: [] }]);
  }
});

test("mapInputSqlError leaves other failures alone", () => {
  assert.equal(mapInputSqlError(pgError("23505", "dup"), "x"), undefined);
  assert.equal(mapInputSqlError(pgError("57014", "cancel"), "x"), undefined);
  assert.equal(mapInputSqlError(new Error("plain"), "x"), undefined);
  assert.equal(mapInputSqlError(null, "x"), undefined);
  assert.equal(mapInputSqlError("string", "x"), undefined);
});
