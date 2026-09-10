import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { runNonActiveOperation, runOperation } from "./operation.ts";

test("operation wrappers preserve values and errors without an OTel SDK", async () => {
  trace.disable();

  const value = await runOperation(
    "searchgres.test.async",
    { schema: "test_index" },
    async () => 42,
  );
  assert.equal(value, 42);

  const marker = new Error("marker");
  await assert.rejects(
    () =>
      runOperation(
        "searchgres.test.error",
        { schema: "test_index" },
        async () => {
          throw marker;
        },
      ),
    (error) => error === marker,
  );

  assert.equal(
    runNonActiveOperation(
      "searchgres.test.sync",
      { schema: "test_index" },
      () => "ok",
    ),
    "ok",
  );
});
