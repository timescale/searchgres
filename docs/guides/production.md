# Run in production

searchgres is a library over a database you operate. This guide covers the
operational concerns that go beyond a single process.

## Shutdown

searchgres never closes the caller-owned database connection. Close it after
application work finishes:

```ts
await sql.end();
```

If you run a background embedding worker, stop it first so its in-flight batch
can finish:

```ts
await worker.stop();
await sql.end();
```

## Separate ingestion from embedding

Because embedding work lives in a database queue, you can split responsibilities:

- **Ingestion processes** write records and need no embedding credentials at all:
  open the index with
  [`noEmbedding`](embeddings.md#credential-separation).
- **An embedding process** opens the index with a real `EmbeddingModel` and
  drains the queue.

This keeps provider keys off your write path and lets you scale embedding
independently. Any number of drainers can run concurrently against one index
without double-embedding.

Choose a drain strategy:

| Strategy | How | Good for |
| --- | --- | --- |
| Cron / scheduled | `processEmbeddings({ maxDurationMs })` per run | Bursty or batch ingestion |
| Serverless | `processEmbeddings({ maxBatches, signal })` | Event-driven pipelines |
| Long-running worker | `startEmbeddingWorker()` | Steady, low-latency indexing |

## Monitor the queue

Track [`queueStats()`](embeddings.md#monitor-the-queue) and alert on:

- **`pending` trending up** or a stale **`oldestPendingAt`** — drain capacity is
  behind ingestion.
- **`failed` rising** — current record versions exhausted their embedding
  attempts and still have no vector; list and diagnose them.

```ts
const { pending, failed, oldestPendingAt } = await index.queueStats();

const failures = await index.listEmbeddingFailures({ limit: 100 });
```

After correcting the underlying transient provider, credential, or network
problem, reset selected rows explicitly:

```ts
await index.retryEmbeddingFailures({
  queueIds: failures.map((failure) => failure.queueId),
});
```

Do not use identical re-ingestion as recovery: an unchanged upsert is a no-op
and does not enqueue new work. See
[Inspect and retry terminal failures](embeddings.md#inspect-and-retry-terminal-failures)
for pagination, retry, and pruning semantics.

If you run `startEmbeddingWorker()`, pass
[`onError`](embeddings.md#run-a-continuous-worker): the worker retries a
failing pass silently otherwise, so a revoked key or wrong-dimension model
shows up only as `pending` climbing.

Prune terminal rows periodically if you don't run the worker's idle prune:

```ts
await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Observability

searchgres is instrumented with the OpenTelemetry API. If your app registers an
OTel SDK you get traces automatically; if it doesn't, instrumentation is a
no-op and costs nothing.

Every SQL statement emits a child span with the query text and timing, nested
under the operation that issued it, on a dedicated `searchgres/sql`
instrumentation scope — so you can filter those spans out in your SDK if they're
too chatty. Parameter values (including vectors) are never attached to spans.

Each drain pass (`processEmbeddings`, or one worker tick) is an
`embedding.process` span. A pass that throws gets `ERROR` status with the
exception recorded; an ordinary provider failure that the pass absorbs (rows
marked failed and left to retry) is an `embedding.batch_failed` event on an
otherwise successful span.

## Access control

searchgres has no user, account, or authorization model. The surrounding
application authenticates callers and can translate identity into mandatory
`tree` or `meta` filters:

```ts
const tenantScope = { tree: `tenants.${trustedTenantLabel}` } as const;
const filter = requestFilter
  ? { and: [tenantScope, requestFilter] as const }
  : tenantScope;

const hits = await index.search({
  semantic: query,
  fulltext: query,
  filter,
});
```

This is an authorization boundary only when the application constructs the
final filter and the caller cannot access an unscoped index handle or issue
unrestricted SQL. Never trust a caller merely to include its own tenant filter.
Validate or map external tenant identifiers to legal `ltree` labels rather than
interpolating them directly.

Database roles and grants provide another boundary. The index's SQL routines run
as `security invoker`, so they act with the calling role's privileges. Grant each
role only what it needs, and use separate indexes or database-level policy when
your threat model requires stronger physical or database enforcement.

See [Architecture and responsibilities](../concepts/architecture.md#access-control-with-composable-filters).

## Reindexing and cutover

Index shape (dimensions, vector type) is immutable, and switching embedding
models requires re-embedding. Rebuild into a new schema and perform a controlled
cutover:

1. Create a new index schema with the new shape.
2. Backfill records into it from your source of truth.
3. Drain embeddings.
4. Validate search quality.
5. Switch application traffic to the new schema name.
6. Drop the old index.

To avoid an interruption while writes continue during backfill, the application
must account for those concurrent changes—for example with dual writes or a
final change-data catch-up before switching traffic. searchgres does not
coordinate that application-level migration.

The step-by-step version is in
[Create and manage indexes](indexes.md#rebuild-and-cut-over).

## Backups and recovery

An index is ordinary PostgreSQL data in a schema you named. It is covered by your
normal backup, point-in-time recovery, and replication setup — nothing
searchgres-specific is required. Records with missing vectors are simply
re-embedded by draining the queue after a restore.
