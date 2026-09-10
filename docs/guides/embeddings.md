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

If every vector comes from your own pipeline, the handle never needs a model:
open it with `noEmbedding` (see [Credential separation](#credential-separation)).

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
  onError(error, { phase, consecutiveErrors, backoffMs }) {
    logger.error({ error, phase, consecutiveErrors, backoffMs }, "embedding worker");
  },
});

// on shutdown — finishes the in-flight batch, then stops.
await worker.stop();
```

The worker processes a batch, immediately continues while work exists, and
sleeps `intervalMs` when idle. `stop()` is graceful: it interrupts the idle wait,
lets any in-flight batch finish, and never closes your pool.

**Always pass `onError`.** The worker catches failures from individual drain or
prune ticks and keeps its polling loop running: when a pass throws — a
misconfigured model (`DimensionMismatchError`), a revoked key
(`EmbeddingProviderError`), an unreachable database — it backs off
exponentially (up to 60s) and retries. Process termination and fatal failures
outside that guarded loop still stop the worker. `onError` is how you find out. It
receives the error plus `phase` (`process` for a drain pass, `prune` for idle
pruning), `consecutiveErrors`, and the `backoffMs` it is about to sleep. A
`RateLimitError` is reported too, with the provider's retry delay as
`backoffMs`, and does not count toward `consecutiveErrors`. Call `worker.stop()`
from inside it if you would rather give up than retry. A throwing callback is
ignored.

Ordinary per-row provider failures do not reach `onError`: they are recorded on
the queue row (`last_error`) and retried up to `maxAttempts`. If the current
record version still has no vector after exhausting that budget, it shows up in
[`queueStats().failed`](#monitor-the-queue) and
[`listEmbeddingFailures()`](#inspect-and-retry-terminal-failures).

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
| `failed` | Current record versions that exhausted their attempts and still have no vector. |
| `oldestPendingAt` | Enqueue time of the oldest pending row, or `null` when idle. |

A steadily rising `pending` or an old `oldestPendingAt` means your drain capacity
isn't keeping up. A growing `failed` count means current record versions have
exhausted their attempt budget. Inspect those failures rather than re-ingesting
the records: an identical upsert is intentionally a no-op and does not enqueue
fresh work.

### Inspect and retry terminal failures

List current unresolved failures in ascending queue-id order:

```ts
const failures = await index.listEmbeddingFailures({ limit: 100 });

for (const failure of failures) {
  logger.error({
    queueId: failure.queueId,
    recordId: failure.recordId,
    attempts: failure.attempts,
    error: failure.lastError,
    failedAt: failure.failedAt,
  });
}
```

Each result describes a failed job only while its `contentVersion` is still the
record's current version and the record still lacks a vector. Historical jobs
superseded by changed content or a supplied vector are excluded. To fetch the
next page, pass the last result's `queueId` as `after`.

After correcting a temporary network problem, revoked credential, or provider
configuration, explicitly reset selected failures to pending work:

```ts
const result = await index.retryEmbeddingFailures({
  queueIds: failures.map((failure) => failure.queueId),
});
// { retried, skipped }
```

Retry accepts at most 1,000 unique queue ids. It resets attempts and makes
current failures immediately claimable. `skipped` counts jobs that became stale,
were resolved or pruned, were already retried, or do not exist. Retrying is
version-guarded and never resurrects work for old content.

Rate limits normally do not appear here: searchgres refunds those attempts and
leaves the work pending with the provider's backoff. Wrong-dimension output also
leaves work pending and requires correcting the model/index configuration.
Terminal retry is for ordinary failures whose underlying cause has been fixed;
do not blindly retry a permanent error.

Failure diagnostics are available only until terminal rows are pruned. Prune
terminal rows manually if you aren't running the worker's idle prune:

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
no embedding credentials at all. Open it with `noEmbedding`:

```ts
import { noEmbedding, openIndex } from "searchgres";

const ingest = await openIndex(sql, "docs_index", { embedding: noEmbedding });
await ingest.upsertMany(records); // queues embedding work as usual
```

Such a handle can write, read, run keyword and filter search, search by a
precomputed `vector`, inspect the queue, and reset selected terminal failures.
Anything that would have to call a model — `search({ semantic })`,
`processEmbeddings()`, `startEmbeddingWorker()` — throws
`EmbeddingUnavailableError` without touching the queue. A separate
process — the one that opens the index with an embedding model — drains it. See
[Run in production](production.md).

Next: [Search and filter](search.md).
