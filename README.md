# searchgres

Postgres-native hybrid search for TypeScript. Semantic + BM25 retrieval with
composable filtering — hierarchy, metadata, temporal, and regex — over a
PostgreSQL database you own and run.

> **Status: pre-release, under active development.** Index provisioning,
> validation, writes, and search are implemented. Record reads, deletes,
> workers, and tree operations remain design targets. Expect breaking changes
> until `1.0`.

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
  provider or a custom implementation of its embedding-model interface.
- **Your database, your pool** — you pass in a `postgres.js` connection; the
  library never opens or closes connections behind your back.
- **Runs anywhere JavaScript does** — Node, Bun, and Deno.

## Requirements

- **PostgreSQL 18** with three extensions:
  - [`pgvector`](https://github.com/pgvector/pgvector) — vector storage + HNSW index
  - [`pg_textsearch`](https://github.com/timescale/pg_textsearch) — BM25 ranking
  - `ltree` — hierarchical paths (ships with Postgres)
- **Node ≥ 22**, **Bun ≥ 1.2**, or **Deno ≥ 2.0**

A Docker image with all three extensions preinstalled is provided for local
development and self-hosting.

## Install

```bash
npm install searchgres postgres
```

Add the embedding provider you want searchgres to use:

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
  dimensions: 1536,
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
```

`upsert()` returns an `{ id, status }` result. See
[the library documentation](docs/library/README.md) for the implemented API.

## Search modes

The retrieval mode is inferred from the arms you pass — there is no `mode` flag:

| Supplied | What it does |
| --- | --- |
| `semantic` or `vector` | Vector similarity (cosine) over embeddings. |
| `fulltext` | BM25 over content — exact identifiers, terms, and phrases. |
| a semantic arm **and** `fulltext` | Runs both and fuses the rankings with RRF. |
| neither | Filter-only listing, ordered by id (chronological). |

`semantic` is embedded with the index's model; `vector` is a precomputed query
vector that skips the model. Hybrid search is a fused **top-k** operation — to
see more results, raise `limit`; the fused score reflects rank within a
candidate window, so there's no cursor to page through.

## Filtering

Filters are a composable boolean tree (`and` / `or` / `not` over leaves) and
apply to every mode:

```ts
await idx.search({
  semantic: "rate limiting",
  fulltext: "rate limit",
  filter: {
    and: [
      { tree: "docs.api" },                 // subtree containment
      { or: [
        { meta: { source: "runbook" } },    // JSONB containment
        { metaPredicate: "$.version >= 3" }, // JSONPath predicate
      ] },
      { temporalOverlaps: ["2026-01-01", "2026-07-01"] },
      { not: { regexp: "deprecated" } },     // case-insensitive POSIX
    ],
  },
  limit: 20,
});
```

- **Hierarchy** — `tree` matches a path and everything under it; `lquery`
  (`"docs.*.api"`) and `ltxtquery` (`"api & v2"`) are pattern leaves. Paths are
  dotted `ltree` values.
- **Metadata** — `meta` for containment, `metaPredicate` for a JSONPath
  expression.
- **Temporal** — `temporalWithin`, `temporalOverlaps`, `temporalBefore`,
  `temporalAfter`, `temporalContains`.
- **Regex** — a precision filter. In a filter-only search it must accompany an
  indexable filter (a regex alone would scan the whole index).

A filter-only search (no ranking arm) returns records in `id` order — which is
chronological, since ids are UUIDv7 — and supports keyset pagination via
`after`/`before`.

## Embeddings

searchgres never handles API keys. You pass an `EmbeddingModel` from the AI SDK,
and the provider package reads its own environment variable. Custom
implementations of the AI SDK interface work too:

```ts
import { openai } from "@ai-sdk/openai";      // reads OPENAI_API_KEY
import { mistral } from "@ai-sdk/mistral";    // reads MISTRAL_API_KEY

const idx = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});
```

The embedder is required when opening an index. searchgres does not persist or
compare model identity: use the dimensions supplied to `createIndex`, and
re-embed the corpus before switching models. Returned vector lengths are checked
against the embedding column's PostgreSQL typmod.

### Queued by design

A null embedding on insert or content update is queued for embedding. This is
enforced by database triggers, including when application SQL, another service,
or a database function writes directly to the index's `record` table without
using searchgres. A precomputed replacement embedding is preserved and skips the
queue; a content update without one invalidates the prior embedding and queues
work. The queue is therefore part of the index's correctness model, not an
optional write mode.

Run one bounded drain from a cron job or after bulk ingestion:

```ts
await idx.processEmbeddings({ batchSize: 50 });
```

...or run a continuous worker:

```ts
const worker = idx.startEmbeddingWorker({ intervalMs: 1000 });
// later: await worker.stop();
```

Because the queue and trigger live in the database, **the process doing the
writing needs no AI credentials at all**. A separate process can open the index
with the required embedder and fill in vectors. Monitor `queueStats()`; records
with null embeddings are available to filters and BM25 immediately, but do not
participate in semantic retrieval until drained.

### Direct Values

Records accept either asynchronous or precomputed embeddings. A precomputed
embedding remains on the row; omitting it queues asynchronous work. Temporal
values are a one- or two-element tuple of `Date` or ISO timestamp strings with an
explicit offset:

```ts
await index.upsert(
  {
    content: "Maintenance window begins at 14:30 UTC.",
    tree: "docs.operations",
    name: "maintenance-window",
    temporal: [new Date("2026-08-26T14:30:00Z")],
    // embedding: [0.012, -0.044, ...], // optional precomputed vector
  },
  { onConflict: "replace" },
);
```

A one-element temporal tuple is stored as a point `[t, t]`; two elements are
stored as `[start, end)`.

Record IDs are UUIDv7. searchgres generates one when omitted; caller-supplied
IDs must also be UUIDv7, which keeps primary-key indexes append-friendly.

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
const archive = await openIndex(other, "archive_index", { embedding: model });
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

The current library documentation is in [docs/library](docs/library/README.md):

- [Installation](docs/library/installation.md)
- [Creating and opening indexes](docs/library/indexes.md)
- [Writing records](docs/library/writes.md)
- [Searching records](docs/library/search.md)
- [Extensions and schemas](docs/library/extensions.md)

## License

[Apache 2.0](LICENSE)

searchgres is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See [NOTICE](NOTICE).
