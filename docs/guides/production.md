# Run in production

searchgres is a library over a database you operate. This guide covers the
operational concerns that go beyond a single process.

## Connections and shutdown

You create and own the `postgres.js` pool. searchgres never opens, closes, or
persistently reconfigures it.

- Size the pool for your workload and share one pool across index handles on the
  same database.
- Close it on shutdown, after your work finishes:

  ```ts
  await sql.end();
  ```

- If you run a background embedding worker, stop it before closing the pool so
  its in-flight batch can finish:

  ```ts
  await worker.stop();
  await sql.end();
  ```

If you route through a transaction pooler such as PgBouncer, use session pooling
(or a dedicated direct connection) for the embedding worker, which relies on
transaction-scoped locks and leases.

## Separate ingestion from embedding

Because embedding work lives in a database queue, you can split responsibilities:

- **Ingestion processes** write records and need no embedding credentials at all.
- **An embedding process** opens the index with an `EmbeddingModel` and drains
  the queue.

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
- **`failed` rising** — embedding is failing for some records; inspect and
  re-ingest them.

```ts
const { pending, failed, oldestPendingAt } = await index.queueStats();
```

Prune terminal rows periodically if you don't run the worker's idle prune:

```ts
await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Observability

searchgres is instrumented with the OpenTelemetry API. If your app registers an
OTel SDK you get traces and metrics automatically; if it doesn't, instrumentation
is a no-op and costs nothing.

Every SQL statement emits a child span with the query text and timing, nested
under the operation that issued it, on a dedicated `searchgres/sql`
instrumentation scope — so you can filter those spans out in your SDK if they're
too chatty. Parameter values (including vectors) are never attached to spans.

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
models requires re-embedding. Do it as a build-and-cut-over, with no downtime:

1. Create a new index schema with the new shape.
2. Backfill records into it from your source of truth.
3. Drain embeddings.
4. Validate search quality.
5. Switch application traffic to the new schema name.
6. Drop the old index.

The step-by-step version is in
[Create and manage indexes](indexes.md#rebuild-and-cut-over).

## Backups and recovery

An index is ordinary PostgreSQL data in a schema you named. It is covered by your
normal backup, point-in-time recovery, and replication setup — nothing
searchgres-specific is required. Records with missing vectors are simply
re-embedded by draining the queue after a restore.
