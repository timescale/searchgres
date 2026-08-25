import assert from "node:assert/strict";
import { test } from "node:test";
import { trace } from "@opentelemetry/api";
import { runSql } from "./exec.ts";

test("runs without a registered OpenTelemetry SDK", async () => {
  trace.disable();
  const result = await runSql(
    Promise.resolve({
      length: 1,
      statement: { string: "select 1" },
    }),
    { spanName: "testSqlQuery", dbOperationName: "SELECT" },
  );
  assert.equal(result.length, 1);
});
