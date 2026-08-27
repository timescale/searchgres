import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { DimensionMismatchError, RateLimitError } from "../src/errors.ts";
import { type Index, openIndex } from "../src/open-index.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import {
  type ControllableEmbeddingModel,
  controllableEmbeddingModel,
  rateLimitError,
} from "./support/embedding.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(
  fn: (index: Index, model: ControllableEmbeddingModel) => Promise<void>,
  model: ControllableEmbeddingModel = controllableEmbeddingModel(),
): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: model });
    await fn(index, model);
  } finally {
    await dropTestSchema(sql, schema);
  }
}

interface QueueRow {
  readonly id: string;
  readonly content_version: number;
  readonly attempts: number;
  readonly outcome: string | null;
  readonly last_error: string | null;
  readonly visible_future: boolean;
}

async function queueRows(schema: string): Promise<readonly QueueRow[]> {
  return sql<QueueRow[]>`
    select id::text, content_version, attempts, outcome, last_error,
           (visible_at > now()) as visible_future
    from ${sql(schema)}.embedding_queue
    order by id
  `;
}

async function embeddingOf(schema: string, id: string): Promise<string | null> {
  const [row] = await sql<{ embedding: string | null }[]>`
    select embedding from ${sql(schema)}.record where id = ${id}
  `;
  return row?.embedding ?? null;
}

test("processEmbeddings embeds queued rows and writes vectors back", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) =>
      values.map((value) => (value === "alpha" ? [1, 0, 0, 0] : [0, 1, 0, 0]));

    const [a] = await index.upsertMany([
      { content: "alpha", tree: "docs" },
      { content: "beta", tree: "docs" },
    ]);
    assert.equal((await index.queueStats()).pending, 2);

    const result = await index.processEmbeddings();
    assert.deepEqual(result, {
      claimed: 2,
      embedded: 2,
      failed: 0,
      cancelled: 0,
      remaining: 0,
    });

    assert.equal(await embeddingOf(index.schema, a?.id ?? ""), "[1,0,0,0]");
    assert.equal((await index.queueStats()).pending, 0);

    const hits = await index.search({ vector: [1, 0, 0, 0], limit: 5 });
    assert.equal(hits[0]?.content, "alpha");
  });
});

test("processEmbeddings is a no-op on an empty queue", async () => {
  await withIndex(async (index) => {
    const result = await index.processEmbeddings();
    assert.deepEqual(result, {
      claimed: 0,
      embedded: 0,
      failed: 0,
      cancelled: 0,
      remaining: 0,
    });
  });
});

test("a precomputed embedding written after enqueue cancels the stale row", async () => {
  await withIndex(async (index) => {
    const [row] = await index.upsertMany([{ content: "async", tree: "docs" }]);
    const id = row?.id ?? "";
    assert.equal((await index.queueStats()).pending, 1);

    // Direct repair: supply a vector with no content change. record_integrity
    // advances content_version (embedding changed null->vector) without enqueuing
    // new work, leaving the pending row behind the record version.
    await sql`
      update ${sql(index.schema)}.record
      set embedding = ${"[0,1,0,0]"}::public.halfvec
      where id = ${id}
    `;

    const result = await index.processEmbeddings();
    assert.equal(result.claimed, 0);
    assert.equal(result.embedded, 0);
    assert.equal(result.cancelled, 1);
    // The supplied vector must survive — the worker must not overwrite it.
    assert.equal(await embeddingOf(index.schema, id), "[0,1,0,0]");
    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("write-back cancels when content changes during embedding", async () => {
  await withIndex(async (index, model) => {
    const [row] = await index.upsertMany([{ content: "orig", tree: "docs" }]);
    const id = row?.id ?? "";

    // Mutate the record mid-embed: this bumps content_version, so the claimed
    // v1 write-back must cancel rather than install a now-stale vector.
    model.handler = async (values) => {
      await sql`
        update ${sql(index.schema)}.record
        set content = 'changed'
        where id = ${id}
      `;
      return values.map(() => [1, 0, 0, 0]);
    };

    const result = await index.processEmbeddings({ maxBatches: 1 });
    assert.equal(result.embedded, 0);
    assert.equal(result.cancelled, 1);
    // No stale vector installed; the content change re-enqueued fresh work.
    assert.equal(await embeddingOf(index.schema, id), null);
    assert.ok(result.remaining >= 1);
  });
});

test("concurrent drainers never double-embed", async () => {
  await withIndex(async (index) => {
    await index.upsertMany(
      Array.from({ length: 6 }, (_, i) => ({
        content: `row ${i}`,
        tree: "docs",
      })),
    );

    const [first, second] = await Promise.all([
      index.processEmbeddings(),
      index.processEmbeddings(),
    ]);
    assert.equal(first.embedded + second.embedded, 6);
    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("a rate limit refunds attempts, defers visibility, and throws", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw rateLimitError(50);
    };
    await index.upsertMany([{ content: "rl", tree: "docs" }]);

    await assert.rejects(() => index.processEmbeddings(), RateLimitError);

    const [row] = await queueRows(index.schema);
    assert.equal(row?.outcome, null);
    assert.equal(row?.attempts, 0); // refunded
    assert.equal(row?.visible_future, true); // deferred by backoff
  });
});

test("a wrong-dimension model releases work and throws", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) => values.map(() => [1, 0, 0]); // dim 3 != 4
    await index.upsertMany([{ content: "wd", tree: "docs" }]);

    await assert.rejects(
      () => index.processEmbeddings(),
      DimensionMismatchError,
    );

    const [row] = await queueRows(index.schema);
    assert.equal(row?.outcome, null);
    assert.equal(row?.attempts, 0); // refunded, preserved for a fixed handle
  });
});

test("an ordinary failure records last_error, retries, then terminally fails", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("provider boom");
    };
    await index.upsertMany([{ content: "boom", tree: "docs" }]);

    // leaseDurationMs 0 so the row is immediately reclaimable by the sweep;
    // maxBatches 1 so this pass stops before its own sweep finalizes the row.
    const first = await index.processEmbeddings({
      maxAttempts: 1,
      leaseDurationMs: 0,
      maxBatches: 1,
    });
    assert.equal(first.failed, 1);
    assert.equal(first.embedded, 0);
    const [pending] = await queueRows(index.schema);
    assert.equal(pending?.outcome, null);
    assert.match(pending?.last_error ?? "", /provider boom/);
    assert.equal(pending?.attempts, 1);

    // Next pass: attempts exhausted → the claim sweep finalizes it as failed.
    await index.processEmbeddings({ maxAttempts: 1 });
    const stats = await index.queueStats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.failed, 1);
  });
});

test("queueStats reports pending, waiting, and failed", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "one", tree: "docs" },
      { content: "two", tree: "docs" },
    ]);
    const stats = await index.queueStats();
    assert.equal(stats.pending, 2);
    assert.equal(stats.waiting, 2);
    assert.equal(stats.inFlight, 0);
    assert.equal(stats.failed, 0);
    assert.ok(stats.oldestPendingAt instanceof Date);
  });
});

test("startEmbeddingWorker drains the queue, then stops gracefully", async () => {
  await withIndex(async (index) => {
    await index.upsertMany(
      Array.from({ length: 4 }, (_, i) => ({
        content: `w ${i}`,
        tree: "docs",
      })),
    );

    const worker = index.startEmbeddingWorker({ intervalMs: 20 });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await index.queueStats()).pending === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await worker.stop();
    }

    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("pruneEmbeddingQueue removes terminal rows", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([{ content: "done", tree: "docs" }]);
    await index.processEmbeddings();
    // one 'completed' terminal row now exists
    const pruned = await index.pruneEmbeddingQueue({ retentionMs: 0 });
    assert.equal(pruned, 1);
    assert.equal((await queueRows(index.schema)).length, 0);
  });
});
