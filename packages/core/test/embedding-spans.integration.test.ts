import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { Sql } from "postgres";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import {
  controllableEmbeddingModel,
  rateLimitError,
} from "./support/embedding.ts";

// The provider must be registered before the library modules create their
// tracers, so import them lazily.
let sql: Sql;
let createIndex: typeof import("../src/create-index.ts").createIndex;
let openIndex: typeof import("../src/open-index.ts").openIndex;
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

before(async () => {
  trace.disable();
  trace.setGlobalTracerProvider(provider);
  ({ createIndex } = await import("../src/create-index.ts"));
  ({ openIndex } = await import("../src/open-index.ts"));
  sql = connect();
});

after(async () => {
  await sql.end();
  await provider.shutdown();
  trace.disable();
});

function processSpans() {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) =>
        span.instrumentationScope.name === "searchgres" &&
        span.name === "embedding.process",
    );
}

test("processEmbeddings records pass failures and per-batch provider failures on its span", async () => {
  const schema = randomTestSchema();
  const model = controllableEmbeddingModel();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: model });
    await index.upsertMany([{ content: "s", tree: "docs" }]);

    // 1. A thrown pass (rate limit) → ERROR status + recorded exception.
    model.handler = () => {
      throw rateLimitError(1);
    };
    await assert.rejects(() => index.processEmbeddings());
    await provider.forceFlush();
    let spans = processSpans();
    const errored = spans.at(-1);
    assert.equal(errored?.status.code, SpanStatusCode.ERROR);
    assert.ok(
      errored?.events.some((event) => event.name === "exception"),
      "exception recorded",
    );

    // Make the row claimable again right away, then 2. an ordinary provider
    // failure → pass succeeds (UNSET status) with a batch_failed event.
    await sql`update ${sql(schema)}.embedding_queue set visible_at = now()`;
    model.handler = () => {
      throw new Error("provider boom");
    };
    const result = await index.processEmbeddings({ maxBatches: 1 });
    assert.equal(result.failed, 1);
    await provider.forceFlush();
    spans = processSpans();
    const recorded = spans.at(-1);
    assert.equal(recorded?.status.code, SpanStatusCode.UNSET);
    const event = recorded?.events.find(
      (candidate) => candidate.name === "embedding.batch_failed",
    );
    assert.ok(event, "batch_failed event present");
    assert.equal(event.attributes?.["searchgres.embedding.rows"], 1);
    assert.match(String(event.attributes?.["exception.message"]), /boom/);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
