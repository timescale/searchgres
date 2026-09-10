import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
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
const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

before(async () => {
  trace.disable();
  context.disable();
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
  ({ createIndex } = await import("../src/create-index.ts"));
  ({ openIndex } = await import("../src/open-index.ts"));
  sql = connect();
});

after(async () => {
  await sql.end();
  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
});

function processSpans() {
  return exporter
    .getFinishedSpans()
    .filter(
      (span) =>
        span.instrumentationScope.name === "searchgres" &&
        span.name === "searchgres.embedding.process",
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

test("the worker skips the pending count that processEmbeddings reports as remaining", async () => {
  const schema = randomTestSchema();
  const model = controllableEmbeddingModel();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: model });
    await index.upsertMany([{ content: "s", tree: "docs" }]);

    // The bounded pass counts what is left and reports it.
    const result = await index.processEmbeddings();
    assert.equal(result.embedded, 1);
    assert.equal(result.remaining, 0);
    await provider.forceFlush();
    const passSpan = processSpans().at(-1);
    assert.equal(passSpan?.attributes["searchgres.embedding.remaining"], 0);
    const countBefore = exporter
      .getFinishedSpans()
      .filter((span) => span.name === "pendingEmbeddingCount").length;
    assert.ok(countBefore >= 1, "processEmbeddings counted the queue");

    // The continuous worker decides idleness from claimed/cancelled and must
    // not count the queue on every tick.
    exporter.reset();
    const appTracer = trace.getTracer("test/application");
    await appTracer.startActiveSpan("application.startup", async (parent) => {
      try {
        const worker = index.startEmbeddingWorker({ intervalMs: 10 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await worker.stop();
      } finally {
        parent.end();
      }
    });
    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    const parent = finished.find((span) => span.name === "application.startup");
    const started = finished.find(
      (span) => span.name === "searchgres.embedding.worker.start",
    );
    const stopped = finished.find(
      (span) => span.name === "searchgres.embedding.worker.stop",
    );
    assert.ok(parent);
    assert.equal(
      started?.parentSpanContext?.spanId,
      parent.spanContext().spanId,
    );
    assert.equal(
      stopped?.parentSpanContext?.spanId,
      parent.spanContext().spanId,
    );

    const ticks = processSpans();
    assert.ok(
      ticks.every((tick) => tick.parentSpanContext === undefined),
      "worker ticks inherited the startup context",
    );
    assert.ok(
      ticks.length >= 2,
      `expected several idle ticks, saw ${ticks.length}`,
    );
    for (const tick of ticks) {
      assert.equal(
        tick.attributes["searchgres.embedding.remaining"],
        undefined,
        "worker tick reported remaining",
      );
    }
    const counts = finished.filter(
      (span) => span.name === "pendingEmbeddingCount",
    );
    assert.equal(counts.length, 0, "worker tick counted the queue");
  } finally {
    await dropTestSchema(sql, schema);
  }
});
