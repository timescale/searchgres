import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Sql } from "postgres";
import { expectSqlState } from "./support/assert.ts";
import { connect } from "./support/db.ts";

let sql: Sql;
let runSql: typeof import("../src/sql/exec.ts").runSql;
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

before(async () => {
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  ({ runSql } = await import("../src/sql/exec.ts"));
  sql = connect();
});

after(async () => {
  await sql.end();
  await provider.shutdown();
  trace.disable();
});

test("records parameterized SQL text and errors without parameter values", async () => {
  exporter.reset();
  const [row] = await runSql(
    sql<{ readonly answer: number }[]>`select 42 as answer`,
    {
      spanName: "testSqlQuery",
      dbOperationName: "SELECT",
      namespace: "pg_catalog",
    },
  );
  assert.equal(row?.answer, 42);

  const failure = await expectSqlState(
    () =>
      runSql(sql`select * from searchgres_missing_relation`, {
        spanName: "testSqlError",
        dbOperationName: "SELECT",
        namespace: "pg_catalog",
      }),
    "42P01",
  );
  assert.match(
    (failure as { readonly query?: string }).query ?? "",
    /searchgres_missing_relation/,
  );

  await provider.forceFlush();
  const spans = exporter
    .getFinishedSpans()
    .filter((span) => span.instrumentationScope.name === "searchgres/sql");
  const successful = spans.find((span) =>
    String(span.attributes["db.query.text"]).includes("select 42 as answer"),
  );
  assert.equal(successful?.attributes["searchgres.sql"], true);
  assert.equal(successful?.name, "testSqlQuery");
  assert.equal(successful?.attributes["db.operation.name"], "SELECT");
  assert.equal(successful?.attributes["db.response.returned_rows"], 1);

  const failed = spans.find((span) =>
    String(span.attributes["db.query.text"]).includes(
      "searchgres_missing_relation",
    ),
  );
  assert.equal(failed?.status.code, SpanStatusCode.ERROR);
});
