# API reference

A compact reference for the public API. Each section links to the guide that
explains it in context.

Import everything from the package root:

```ts
import {
  createIndex,
  openIndex,
  dropIndex,
  truncateCharacters,
  truncateBytes,
  truncateTokens,
  noTruncation,
} from "searchgres";
```

## Factory functions

### `createIndex(sql, schema, config)`

Creates a new index schema. Atomic; throws
[`ConflictError`](errors.md) if the schema already exists. See
[Create and manage indexes](../guides/indexes.md).

```ts
await createIndex(sql, "docs_index", {
  dimensions: 1536,        // required; must match your model
  vectorType: "halfvec",   // "halfvec" (default) | "vector"
  bm25: { textConfig: "english", k1: 1.2, b: 0.75 },
  hnsw: { m: 16, efConstruction: 64 },
});
```

| Config field | Default | Notes |
| --- | --- | --- |
| `dimensions` | — (required) | 1–4000 for `halfvec`, 1–2000 for `vector`. |
| `vectorType` | `"halfvec"` | `"halfvec"` or `"vector"`; cosine distance either way. |
| `bm25.textConfig` | `"english"` | Must name an installed text search config. |
| `bm25.k1` | `1.2` | 0.1–10. |
| `bm25.b` | `0.75` | 0–1. |
| `hnsw.m` | `16` | 2–100. |
| `hnsw.efConstruction` | `64` | 4–1000. |

### `openIndex(sql, schema, options) → Promise<Index>`

Opens an existing index and returns a handle.

```ts
const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
  truncate: truncateCharacters(24_000), // optional
});
```

| Option | Required | Notes |
| --- | --- | --- |
| `embedding` | yes | Any AI SDK `EmbeddingModel`. |
| `truncate` | no | A `Truncator`; defaults to `noTruncation`. |

Throws [`InvalidIndexError`](errors.md), [`SchemaVersionError`](errors.md), or
[`ExtensionError`](errors.md).

### `dropIndex(sql, schema) → Promise<void>`

Drops a searchgres index schema (`DROP SCHEMA ... CASCADE`) after verifying it is
one. Also available as `index.drop()`.

## The `Index` handle

Obtain a handle from `openIndex()`. Read-only properties: `schema`,
`vectorType`, `dimensions`, `embedding`, `truncate`.

### Writing

| Method | Returns | Guide |
| --- | --- | --- |
| `upsert(record, options?)` | `UpsertResult` | Replaces conflicts by default. [Ingest](../guides/ingest.md) |
| `upsertMany(records, options?)` | `readonly UpsertResult[]` | Replaces conflicts by default. [Ingest](../guides/ingest.md) |
| `insert(record)` | `UpsertResult` | Throws `ConflictError` on a conflict. [Ingest](../guides/ingest.md) |
| `insertMany(records)` | `readonly UpsertResult[]` | Throws `ConflictError` on any conflict. [Ingest](../guides/ingest.md) |

```ts
type UpsertRecord = {
  content: string;
  tree?: string;
  name?: string | null;
  meta?: Record<string, unknown>;
  temporal?: readonly [Date | string] | readonly [Date | string, Date | string];
  id?: string;
  embedding?: readonly number[];
};

type UpsertOptions = { onConflict?: "error" | "ignore" | "replace" };

type UpsertResult = { id: string; status: "inserted" | "updated" | "skipped" };
```

`upsertMany` accepts at most 1,000 records ([`BatchTooLargeError`](errors.md)
above that).

### Reading

| Method | Returns | Notes |
| --- | --- | --- |
| `get(id)` | `StoredRecord` | Throws `NotFoundError`. |
| `getByName(tree, name)` | `StoredRecord` | Throws `NotFoundError`. |
| `patch(id, priorVersionHash, input)` | `StoredRecord` | Throws `NotFoundError` / `StaleVersionError`. |
| `delete(id)` | `void` | Throws `NotFoundError`. |
| `deleteByName(tree, name)` | `void` | Throws `NotFoundError`. |

```ts
type StoredRecord = {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  name: string | null;
  hasEmbedding: boolean;
  version: string;
  versionHash: string;
  createdAt: Date;
  updatedAt: Date | null;
};

type PatchInput = {
  content?: string;
  meta?: Record<string, unknown>;
  tree?: string;
  name?: string | null;
  temporal?: (readonly [Date | string] | readonly [Date | string, Date | string]) | null;
  embedding?: readonly number[];
};
```

See [Manage records and trees](../guides/records-and-trees.md).

### Searching

`search(options?) → Promise<readonly SearchResult[]>`. See
[Search and filter](../guides/search.md).

```ts
type SearchOptions = {
  // arms — semantic and vector are mutually exclusive
  semantic?: string;
  vector?: readonly number[];
  fulltext?: string;

  filter?: Filter;

  // ranking
  limit?: number;              // default 10
  semanticThreshold?: number;  // 0–1, semantic/hybrid
  k?: number;                  // hybrid, default 60
  candidateLimit?: number;     // hybrid, default 30
  fulltextWeight?: number;     // hybrid, 0–1, default 1
  semanticWeight?: number;     // hybrid, 0–1, default 1

  // filter-only listing
  order?: "asc" | "desc";
  after?: string;
  before?: string;
};

type Filter =
  | { and: readonly Filter[] }        // ≥ 2 children
  | { or: readonly Filter[] }         // ≥ 2 children
  | { not: Filter }
  | { tree: string }
  | { lquery: string }
  | { ltxtquery: string }
  | { meta: Record<string, unknown> }
  | { metaPredicate: string }
  | { temporalWithin: readonly [Date | string, Date | string] }
  | { temporalOverlaps: readonly [Date | string, Date | string] }
  | { temporalBefore: Date | string }
  | { temporalAfter: Date | string }
  | { temporalContains: Date | string }
  | { regexp: string };
```

### Tree operations

| Method | Returns | Notes |
| --- | --- | --- |
| `moveTree(source, destination, options?)` | `{ count }` | `options.dryRun` previews. |
| `copyTree(source, destination, options?)` | `{ count }` | Fresh ids; conflicts throw `ConflictError`. |
| `deleteTree(tree, options?)` | `{ count }` | Inclusive subtree. |
| `countTree(selector, options?)` | `{ count, capped }` | Selector: one of `tree`/`lquery`/`ltxtquery`; `options.limit` caps. |
| `listTree(lquery)` | `readonly { tree, count }[]` | Descendant counts per node. |

### Embeddings

| Method | Returns | Guide |
| --- | --- | --- |
| `processEmbeddings(options?)` | `ProcessEmbeddingsResult` | [Embeddings](../guides/embeddings.md) |
| `startEmbeddingWorker(options?)` | `EmbeddingWorker` | [Embeddings](../guides/embeddings.md) |
| `queueStats()` | `QueueStats` | [Embeddings](../guides/embeddings.md) |
| `pruneEmbeddingQueue({ retentionMs })` | `number` | [Embeddings](../guides/embeddings.md) |

```ts
type ProcessEmbeddingsOptions = {
  batchSize?: number;
  maxBatches?: number;
  maxDurationMs?: number;
  leaseDurationMs?: number;  // default 300000
  maxAttempts?: number;      // default 3
  signal?: AbortSignal;
};

type ProcessEmbeddingsResult = {
  claimed: number;
  embedded: number;
  failed: number;
  cancelled: number;
  remaining: number;
};

type EmbeddingWorkerOptions = {
  intervalMs?: number;        // default 1000
  batchSize?: number;
  leaseDurationMs?: number;   // default 300000
  maxAttempts?: number;       // default 3
  pruneRetentionMs?: number;  // default 604800000
};

type EmbeddingWorker = { stop(): Promise<void> };

type QueueStats = {
  pending: number;
  inFlight: number;
  waiting: number;
  failed: number;
  oldestPendingAt: Date | null;
};
```

### Transactions and lifecycle

| Method | Returns | Notes |
| --- | --- | --- |
| `with(tx)` | `TransactionIndex` | Record/tree/search/write ops bound to a caller transaction. |
| `drop()` | `void` | `DROP SCHEMA ... CASCADE`. |

`TransactionIndex` excludes the embedding and queue methods by design. See
[Manage records and trees](../guides/records-and-trees.md#compose-in-a-transaction).

## Truncators

Runtime policy applied to record content and query text before embedding.

```ts
noTruncation                              // default; no-op
truncateCharacters(maxChars)              // UTF-16 code units
truncateBytes(maxBytes)                   // UTF-8 bytes
truncateTokens({ encode, decode, maxTokens }) // caller-supplied codec
```

```ts
type Truncator = (text: string) => string | Promise<string>;
type TokenCodec = {
  encode(text: string): ArrayLike<number>;
  decode(tokens: number[]): string;
};
```

## Errors

All errors extend `SearchgresError`. See [Errors and recovery](errors.md).
