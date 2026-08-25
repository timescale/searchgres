import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LockTimeoutError,
  StatementTimeoutError,
  TransactionTimeoutError,
} from "../errors.ts";
import { mapSqlError, postgresErrorCode } from "./errors.ts";

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
