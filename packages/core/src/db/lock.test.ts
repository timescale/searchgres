import assert from "node:assert/strict";
import { test } from "node:test";
import { advisoryLockKey } from "./lock.ts";

test("advisory lock keys are stable and namespaced", () => {
  const first = advisoryLockKey("searchgres:extensions");
  assert.deepEqual(first, advisoryLockKey("searchgres:extensions"));
  assert.notDeepEqual(first, advisoryLockKey("searchgres:index:docs"));
  assert.equal(first.length, 2);
  assert.ok(Number.isInteger(first[0]));
  assert.ok(Number.isInteger(first[1]));
});
