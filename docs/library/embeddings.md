# Embeddings and the drain engine

A record with no embedding — inserted without one, or whose content changed
without a replacement vector — is immediately searchable by filters and BM25,
but does not participate in semantic search until its vector is generated. That
generation is asynchronous: database triggers enqueue the work, and a drainer
embeds it later. This holds for any writer, including direct SQL.

## Writing vectors

You can supply a precomputed vector, or let the queue handle it:

```ts
// Precomputed — stored as-is, no queue work.
await index.upsert({ content, tree: "docs", embedding: [/* index.dimensions */] });

// No embedding — queued for the drainer.
await index.upsert({ content, tree: "docs" });
```

Supplying a vector later (with no content change) is honored too: the trigger
advances the record's `content_version`, which invalidates any queue row still
referring to the old state, so a drainer can never overwrite your vector.

## Draining on demand

Run one bounded pass — for a cron job, after a bulk ingest, or in a serverless
invocation:

```ts
const result = await index.processEmbeddings({
  batchSize: 50,        // clamped to the model's maxEmbeddingsPerCall
  maxBatches: 10,       // default: drain until no claimable work remains
  maxDurationMs: 30_000,
  signal,               // cooperative cancellation (checked before each claim)
});
// { claimed, embedded, failed, cancelled, remaining }
```

- `embedded` — vectors written back and finalized.
- `failed` — provider/write-back failures this pass; the rows stay pending and
  retry after their lease, then become terminally `failed` once attempts run out.
- `cancelled` — rows dropped as stale (a newer record state exists).
- `remaining` — pending rows after the pass.

A provider **rate limit** and a **wrong vector dimension** are not per-row
failures: the pass releases and refunds the claimed rows, then throws
`RateLimitError` (carrying retry-after) or `DimensionMismatchError`. The work is
preserved for a later retry or a correctly configured handle.

## Draining continuously

```ts
const worker = index.startEmbeddingWorker({
  intervalMs: 1_000,       // idle poll delay
  batchSize: 50,
  pruneRetentionMs: 604_800_000, // terminal rows pruned opportunistically when idle
});

// later — finishes the in-flight batch, then halts. Never closes your pool.
await worker.stop();
```

The worker processes one batch per tick, continues immediately while work
exists, and sleeps `intervalMs` when idle. It is concurrency-safe: many workers
or processes can drain one index via `for update skip locked`.

## Maintenance and visibility

```ts
const stats = await index.queueStats();
// { pending, inFlight, waiting, failed, oldestPendingAt }

await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Tuning

All durations are milliseconds:

- `leaseDurationMs` (default 300000) — how long a claimed row is hidden from
  other drainers. A crashed drainer's rows reappear after the lease.
- `maxAttempts` (default 3) — attempts before a row is terminally `failed`.
- `pruneRetentionMs` (default 604800000) — terminal-row retention.

## Correctness model

- **Enqueue is trigger-driven**, so direct SQL writers get queue work too.
- **`content_version` is the staleness fence.** It advances whenever the
  embedding input changes (content, or the stored vector itself). Claims cancel
  rows whose version no longer matches the record; write-back installs a vector
  only if the record still has the claimed version. A vector generated for an
  old state can never overwrite a newer one.
- **The queue is the retry authority**, not the embedding SDK. Ordinary failures
  record `last_error` and retry; the SDK is called once per batch, outside any
  transaction.

## Credential separation

Because the queue and triggers live in the database, a process that only writes
records needs no embedding credentials. A separate process opens the index with
an `EmbeddingModel` and drains the queue.
