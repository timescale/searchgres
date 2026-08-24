# searchgres

Postgres-native hybrid search for TypeScript. Semantic + BM25 retrieval with
composable filtering — hierarchy, metadata, temporal, and regex — over a
PostgreSQL database you own and run.

> **Status: pre-release, under active development.** The API described below is
> the design target and is not yet implemented. Expect breaking changes until
> `1.0`. Don't build on it yet.

## Why

Most RAG stacks bolt a vector database onto the side of the database that
already holds your data, then reconcile two systems forever. searchgres keeps
retrieval where your data lives: real BM25 keyword search, HNSW vector search,
and rank fusion — all executed in Postgres, filtered by the same query.

- **Hybrid by default** — semantic and keyword results fused with Reciprocal
  Rank Fusion, not one or the other.
- **Filters that compose** — scope a search by tree path, JSONB metadata
  (containment or JSONPath), a time range, or a regex, in the same call.
- **Bring your own embedding model** — any [AI SDK](https://sdk.vercel.ai)
  provider, or none at all if you supply vectors yourself.
- **Your database, your pool** — you pass in a `postgres.js` connection; the
  library never opens or closes connections behind your back.
- **Runs anywhere JavaScript does** — Node, Bun, and Deno.

## Requirements

- **PostgreSQL 18** with three extensions:
  - [`pgvector`](https://github.com/pgvector/pgvector) — vector storage + HNSW index
  - [`pg_textsearch`](https://github.com/timescale/pg_textsearch) — BM25 ranking
  - `ltree` — hierarchical paths (ships with Postgres)
- **Node ≥ 20**, **Bun ≥ 1.2**, or **Deno ≥ 2.0**

A Docker image with all three extensions preinstalled is provided for local
development and self-hosting.

## Install

```bash
npm install searchgres postgres
```

Add an embedding provider if you want searchgres to generate vectors:

```bash
npm install @ai-sdk/openai   # or any other AI SDK provider
```

## Quick start

```ts
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const sql = postgres(process.env.DATABASE_URL);

// Create an index. Each index is its own Postgres schema.
await createIndex(sql, "docs_index", {
  embedding: {
    provider: "openai",
    modelId: "text-embedding-3-small",
    dimensions: 1536,
  },
});

// Open it, supplying the model to embed with. The API key comes from the
// provider's own environment variable — searchgres never handles secrets.
const idx = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

await idx.upsert({
  content: "Auth tokens are rotated every 24 hours by the scheduler.",
  tree: "docs.auth",
  meta: { source: "runbook", version: 3 },
});

const hits = await idx.search({
  query: "how often do credentials refresh?",
  mode: "hybrid",
  limit: 10,
});
```

Each hit is the full record plus a `score`.

## Search modes

| Mode | What it does |
| --- | --- |
| `semantic` | Vector similarity (cosine) over embeddings — finds related meaning when the wording differs. |
| `keyword` | BM25 over content — finds exact identifiers, terms, and phrases. |
| `hybrid` | Runs both and fuses the rankings with RRF. Results that rank well in both arms rise to the top. |

Hybrid search is a fused **top-k** operation. To see more results, raise
`limit` — the fused score reflects rank position within a candidate window, so
it isn't an absolute relevance measure and there's no cursor to page through.

## Filtering

Filters compose with any search mode, and can be used on their own:

```ts
await idx.search({
  query: "rate limiting",
  mode: "hybrid",

  tree: "docs.api",                     // this subtree only
  meta: { source: "runbook" },          // JSONB containment
  metaPredicate: "$.version >= 3",      // JSONPath predicate
  temporal: { overlaps: ["2026-01-01", "2026-07-01"] },
  regexp: "429|throttl",                // case-insensitive POSIX

  limit: 20,
});
```

- **Hierarchy** — `tree` matches a path and everything under it. For patterns,
  use `lquery` (`"docs.*.api"`) or `ltxtquery` (`"api & v2"`) instead. Paths are
  dotted `ltree` values.
- **Metadata** — `meta` for containment, `metaPredicate` for a JSONPath
  expression.
- **Temporal** — records can carry a time range (a point in time or an
  interval); filter by `within`, `overlaps`, `before`, `after`, or `contains`.
- **Regex** — a precision filter. It must accompany another criterion, since a
  regex alone would scan the whole index.

A filter-only search (no `query`) returns records in `id` order — which is
chronological, since ids are UUIDv7 — and supports keyset pagination via
`after`.

## Embeddings

searchgres never handles API keys. You pass an `EmbeddingModel` from the AI SDK,
and the provider package reads its own environment variable:

```ts
import { openai } from "@ai-sdk/openai";      // reads OPENAI_API_KEY
import { mistral } from "@ai-sdk/mistral";    // reads MISTRAL_API_KEY

const idx = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});
```

The model, provider, and dimensions you chose at `createIndex` are stored with
the index and checked when you open it, so you can't accidentally mix vectors
from two different models.

**The embedder is optional.** Omit it for keyword-only search, or when you
compute vectors yourself and pass them in directly.

### Synchronous or queued

By default, `upsert` embeds inline and stores the vector with the row. You can
defer instead — the record is written immediately (and is searchable by keyword
right away) while its embedding is queued:

```ts
await idx.upsert(record, { embed: "async" });
```

Anything can drain that queue later. Run one bounded pass from a cron job:

```ts
await idx.processEmbeddings({ batchSize: 50 });
```

...or run a continuous worker:

```ts
const worker = idx.startEmbeddingWorker({ intervalMs: 1000 });
// later: await worker.stop();
```

Because the queue lives in the database, **the process doing the writing needs
no AI credentials at all** — only the process draining the queue does. A web
tier can ingest without an embedding model while a separate worker fills in
vectors.

### Long inputs

searchgres can't know an arbitrary provider's token limit, so truncation is
explicit. Nothing is truncated unless you ask:

```ts
import { truncateCharacters } from "searchgres";

const idx = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
  truncate: truncateCharacters(24_000),
});
```

Built-in strategies cover characters, bytes, and exact token counts (with a
tokenizer you supply). One record is one chunk — splitting documents is up to
you.

## Multiple indexes

An index is a Postgres schema, and you pass the schema name. Put as many as you
like in one database, or spread them across databases with separate pools:

```ts
const docs = await openIndex(sql, "docs_index", { embedding: model });
const faqs = await openIndex(sql, "faq_index", { embedding: model });

const other = postgres(process.env.OTHER_DATABASE_URL);
const archive = await openIndex(other, "archive_index");
```

Every query is fully schema-qualified, so indexes sharing a pool never interfere
with each other. searchgres keeps no registry of what exists — your application
tracks the indexes it created.

## Observability

searchgres is instrumented with the OpenTelemetry API. If your app registers an
OTel SDK, you get traces and metrics automatically; if it doesn't, instrumentation
is a no-op and costs nothing.

Every SQL statement gets its own span with the query text and timing, nested
under the operation that issued it — so a slow search shows you exactly which
query was slow. SQL spans are emitted on a dedicated instrumentation scope
(`searchgres/sql`), so you can filter them out in your SDK if they're too
chatty.

## Documentation

Full documentation is in progress. Until then, the design and rationale live in
the requirements document in this repository.

## License

[Apache 2.0](LICENSE)

searchgres is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See [NOTICE](NOTICE).
