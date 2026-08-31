# Generate embeddings

A record is searchable by keyword and filters the moment you write it. Semantic
search needs its embedding vector, and searchgres generates those
**asynchronously** by default: a write enqueues the work, and a drainer produces
the vector afterward.

This keeps writes fast and decouples ingestion from your embedding provider — but
it means you must drain the queue (once, or continuously) before new records
appear in semantic results.

## The lifecycle

1. You write a record without a vector.
2. A database trigger enqueues embedding work for it.
3. A drainer claims the work, calls your embedding model, and writes the vector.
4. The record now participates in semantic and hybrid search.

You choose how step 3 runs: a bounded pass on demand, or a continuous worker.

## Supplying a vector yourself

If you already have a vector, pass it and no queue work is created:

```ts
await index.upsert({
  content: "Maintenance window begins at 14:30 UTC.",
  tree: "docs.ops",
  embedding: [/* exactly index.dimensions finite numbers */],
});
```

You can also supply a vector later, with no content change; searchgres keeps it
and discards any queued work that referred to the old state, so a drainer can
never overwrite it.

## Drain on demand

Run one bounded pass — ideal for a cron job, after a bulk import, or in a
serverless function:

```ts
const result = await index.processEmbeddings({
  batchSize: 50,          // rows per provider call (clamped to the model's max)
  maxBatches: 10,         // stop after this many batches
  maxDurationMs: 30_000,  // stop after this long
  signal,                 // optional AbortSignal, checked before each batch
});

result;
// { claimed, embedded, failed, cancelled, remaining }
```

With no bounds it drains until no claimable work remains, then returns.

The result fields:

- **`embedded`** — vectors written back successfully.
- **`failed`** — provider or write-back failures this pass. These rows stay
  pending and retry after their lease; they become terminally `failed` only once
  their attempts are exhausted.
- **`cancelled`** — rows dropped because the record changed or was deleted (their
  work was stale).
- **`remaining`** — rows still pending after the pass.

A provider **rate limit** or a **wrong vector dimension** aborts the pass by
throwing ([`RateLimitError`](../reference/errors.md) or
[`DimensionMismatchError`](../reference/errors.md)) after releasing the claimed
rows, so the work is preserved for a retry or a corrected configuration.

## Run a continuous worker

For steady ingestion, run a background worker:

```ts
const worker = index.startEmbeddingWorker({
  intervalMs: 1_000,             // poll delay when idle
  batchSize: 50,
  pruneRetentionMs: 604_800_000, // prune terminal rows when idle (7 days)
});

// on shutdown — finishes the in-flight batch, then stops.
await worker.stop();
```

The worker processes a batch, immediately continues while work exists, and
sleeps `intervalMs` when idle. `stop()` is graceful: it interrupts the idle wait,
lets any in-flight batch finish, and never closes your pool.

It is concurrency-safe: run as many workers or processes against one index as you
like — claims use `FOR UPDATE SKIP LOCKED`, so they never double-embed a row.

## Monitor the queue

```ts
const stats = await index.queueStats();
// { pending, inFlight, waiting, failed, oldestPendingAt }
```

| Field | Meaning |
| --- | --- |
| `pending` | Rows awaiting a vector (`waiting` + `inFlight`). |
| `inFlight` | Pending rows a drainer currently holds (lease not yet expired). |
| `waiting` | Pending rows claimable right now. |
| `failed` | Terminal failures still within the retention window. |
| `oldestPendingAt` | Enqueue time of the oldest pending row, or `null` when idle. |

A steadily rising `pending` or an old `oldestPendingAt` means your drain capacity
isn't keeping up. A growing `failed` count means embedding is failing —
inspect it and re-ingest affected records.

Prune terminal rows manually if you aren't running the worker's idle prune:

```ts
await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Tuning

All durations are milliseconds.

- **`leaseDurationMs`** (default `300000`) — how long a claimed row is hidden from
  other drainers. If a drainer crashes, its rows reappear after the lease.
- **`maxAttempts`** (default `3`) — attempts before a row is terminally `failed`.
- **`pruneRetentionMs`** (default `604800000`) — how long terminal rows are kept.

## Why this is safe

You rarely need to think about it, but the guarantees are worth knowing:

- **Any writer enqueues.** The queue is driven by database triggers, so records
  written by direct SQL or another service are embedded too.
- **The queue is the retry authority**, not the embedding SDK. Ordinary failures
  are recorded and retried; the provider is called once per batch, outside any
  transaction.
- **Stale vectors can't win.** Every write-back is guarded by the record's
  version, so a vector generated for an old version of a record is discarded
  rather than overwriting a newer one.

## Credential separation

Because the queue lives in the database, a process that only writes records needs
no embedding credentials at all. A separate process — the one that opens the
index with an embedding model — drains the queue. See
[Run in production](production.md).

Next: [Search and filter](search.md).
