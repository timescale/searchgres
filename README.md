# searchgres

[![npm version](https://img.shields.io/npm/v/searchgres.svg)](https://www.npmjs.com/package/searchgres)
[![CI](https://github.com/timescale/searchgres/actions/workflows/ci.yml/badge.svg)](https://github.com/timescale/searchgres/actions/workflows/ci.yml)
[![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/timescale/searchgres/blob/main/LICENSE)

**Excellent hybrid search in the Postgres you own.**

searchgres is an open-source TypeScript library that combines BM25 keyword
search, vector search, Reciprocal Rank Fusion, and structured filters in
PostgreSQL. Bring a [`postgres.js`](https://github.com/porsager/postgres)
connection and an [AI SDK](https://ai-sdk.dev) embedding model; searchgres
manages the search schema, indexes, and embedding workflow.

- Find both **exact terms and related meaning**.
- Scope retrieval by **hierarchy, JSON metadata, time, and regex**.
- Keep your search index in **PostgreSQL you control**, not a separate vector
  service.
- Use the library directly without adopting a RAG framework, server, or content
  model.

## Install and search

```bash
npm install searchgres postgres @ai-sdk/openai
```

```ts
import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";

const sql = postgres(process.env.DATABASE_URL);

// Run once. An index is a Postgres schema managed by searchgres.
await createIndex(sql, "docs_index", { dimensions: 1536 });

const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

await index.upsertMany([
  {
    content: "Auth tokens rotate every 24 hours.",
    tree: "docs.auth",
    meta: { audience: "operators" },
  },
  {
    content: "Rate limits are 100 requests per minute for each API key.",
    tree: "docs.api",
    meta: { audience: "developers" },
  },
]);

// New records already work with BM25 and filters. Drain before semantic search.
await index.processEmbeddings();

const hits = await index.search({
  semantic: "how are request limits enforced?",
  fulltext: "rate limit",
  filter: {
    and: [
      { tree: "docs.api" },
      { meta: { audience: "developers" } },
    ],
  },
  limit: 5,
});

for (const hit of hits) console.log(hit.score, hit.tree, hit.content);
await sql.end(); // you own the pool
```

See **[Get started](https://github.com/timescale/searchgres/blob/main/docs/getting-started.md)**
for the complete walkthrough.

## Why searchgres

### Search quality beyond vector similarity

Pure semantic search struggles with identifiers, exact phrases, dates, and
scope. searchgres gives each query the retrieval strategy it needs:

- **BM25** for exact and lexical relevance.
- **Vector search** for related meaning when wording differs.
- **RRF hybrid search** to combine both rankings without mixing incompatible raw
  score scales.
- **Composable filters** over tree paths, JSONB metadata and JSONPath, temporal
  ranges, and regex.
- **Filter-only listing** when ranking is unnecessary.

### Postgres-native, not another retrieval stack

A searchgres index is an ordinary PostgreSQL schema containing records, SQL
routines, and native indexes: HNSW through `pgvector`, BM25 through
`pg_textsearch`, GiST for hierarchy and time, and GIN for metadata.

That means one database to operate, one transaction system, normal backups and
replication, and direct SQL access when you need it. Your search index lives in
PostgreSQL you control rather than in a separate proprietary service.

### Search mechanics without application policy

searchgres owns the mechanics of retrieval, not your application architecture:

- You own the connection pool, embedding provider, credentials, and source data.
- You decide how to chunk, summarize, extract, or otherwise derive records.
- You can organize raw and derived records in one index or several indexes.
- You can call the TypeScript API or the schema-local SQL routines.
- The core contains no user, account, or authorization model.

No fact-extraction pipeline, opaque summarization, or RAG framework is imposed.

## How search works

`index.search()` infers the retrieval mode from the arguments you pass:

| Input | Behavior |
| --- | --- |
| `semantic` or a precomputed `vector` | HNSW cosine search |
| `fulltext` | BM25 keyword search |
| `semantic` and `fulltext` | RRF hybrid search |
| filters only | UUIDv7-ordered listing with keyset pagination |
| either ranked arg plus `filter` | Filtered and ranked retrieval |
| both ranked args plus `filter` | Filtered and RRF hybrid search retrieval |

Every hit is the full record plus its score. Newly written records are available
to BM25 and filters immediately; they join semantic and hybrid results after the
built-in embedding queue is drained. Run a bounded `processEmbeddings()` pass or
start a concurrency-safe background `EmbeddingWorker`.

Read **[How search works](https://github.com/timescale/searchgres/blob/main/docs/concepts/how-search-works.md)**
or jump to **[Search and filter](https://github.com/timescale/searchgres/blob/main/docs/guides/search.md)**.

## Compose it into your application

The core is deliberately a library. You can use it to build:

- application search or a hosted search API;
- an indexing pipeline fed from existing tables through code, SQL, or triggers;
- RAG retrieval with your own chunking and generation stages;
- raw, summarized, or fact-extracted representations organized by tree;
- application-enforced access scopes by injecting mandatory tree or metadata
  filters;
- a post-retrieval reranking stage.

Authentication and authorization remain an application or database concern.
Filters become an access-control boundary only when callers cannot bypass the
layer that injects them or issue unrestricted database queries.

See **[Architecture and responsibilities](https://github.com/timescale/searchgres/blob/main/docs/concepts/architecture.md)**
and **[Choosing searchgres](https://github.com/timescale/searchgres/blob/main/docs/comparison.md)**.

## Evidence behind the design

The architecture behind searchgres was evaluated on conversational-memory and
multi-hop retrieval benchmarks using a simplified, prototype based on the same
core approach: one Postgres record table, BM25, HNSW vectors, RRF, and structured
filters—without knowledge graphs or fact-extraction pipelines.

- **LoCoMo:** `F1=0.666` after search-tool refinement, compared with `F1=0.493`
  for the fixed retrieval baseline in the same experiments.
- **MuSiQue:** `86.5%` retrieval recall on a seeded 100-question sample spanning
  two-, three-, and four-hop questions.

These are architecture experiments, not a current leaderboard claim; answering
models, agent behavior, samples, and metrics also affect end-to-end scores. Read
**[Benchmarks and evidence](https://github.com/timescale/searchgres/blob/main/docs/benchmarks/README.md)**
for methodology, results, and qualifications.

## Requirements

- **PostgreSQL 18** with these extensions installed in `public`:
  [`pgvector`](https://github.com/pgvector/pgvector),
  [`pg_textsearch`](https://github.com/timescale/pg_textsearch), and `ltree`.
  `pg_textsearch` must be included in `shared_preload_libraries`.
- **Node ≥ 22**, **Bun ≥ 1.4**, or **Deno ≥ 2.0**.

`createIndex()` installs missing extensions when its database role has the
necessary privileges. The repository includes a PostgreSQL Dockerfile with the
extensions configured. See **[Install searchgres](https://github.com/timescale/searchgres/blob/main/docs/installation.md)**.

## Want a ready-made application?

The core library is the primary product. This repository also includes optional
applications built on it:

- `searchgres-server` exposes one configured index over HTTP.
- `searchgres` is a remote CLI for records, trees, import/export, and search.
- `searchgres-mcp` exposes searchgres tools to MCP-compatible agents.
- The Docker Compose stack runs PostgreSQL, Ollama, provisioning, and the server for a
  no-API-key local evaluation.

Use them as reference implementations, an evaluation environment, or as-is for
remote and agentic search. Start the local evaluation with:

```bash
git clone https://github.com/timescale/searchgres.git
cd searchgres
docker compose up --build
```

See the **[Docker Compose evaluation guide](https://github.com/timescale/searchgres/blob/main/docs/guides/docker-compose.md)**
or **[API server guide](https://github.com/timescale/searchgres/blob/main/docs/guides/server.md)**.

## Documentation

### Learn the core library

- [Get started](https://github.com/timescale/searchgres/blob/main/docs/getting-started.md)
- [How search works](https://github.com/timescale/searchgres/blob/main/docs/concepts/how-search-works.md)
- [Model records](https://github.com/timescale/searchgres/blob/main/docs/concepts/record-model.md)
- [Architecture and responsibilities](https://github.com/timescale/searchgres/blob/main/docs/concepts/architecture.md)
- [Create and manage indexes](https://github.com/timescale/searchgres/blob/main/docs/guides/indexes.md)
- [Ingest records](https://github.com/timescale/searchgres/blob/main/docs/guides/ingest.md)
- [Generate embeddings](https://github.com/timescale/searchgres/blob/main/docs/guides/embeddings.md)
- [Search and filter](https://github.com/timescale/searchgres/blob/main/docs/guides/search.md)
- [Build a RAG retriever](https://github.com/timescale/searchgres/blob/main/docs/guides/rag.md)
- [Manage records and trees](https://github.com/timescale/searchgres/blob/main/docs/guides/records-and-trees.md)
- [Run in production](https://github.com/timescale/searchgres/blob/main/docs/guides/production.md)

### Evaluate and integrate

- [Runnable examples](https://github.com/timescale/searchgres/tree/main/examples)
- [Choosing searchgres](https://github.com/timescale/searchgres/blob/main/docs/comparison.md)
- [Benchmarks and evidence](https://github.com/timescale/searchgres/blob/main/docs/benchmarks/README.md)
- [Configure the API server](https://github.com/timescale/searchgres/blob/main/docs/guides/server.md)
- [Evaluate with Docker Compose](https://github.com/timescale/searchgres/blob/main/docs/guides/docker-compose.md)
- [Use the MCP server](https://github.com/timescale/searchgres/blob/main/docs/mcp/index.md)

### Reference

- [API reference](https://github.com/timescale/searchgres/blob/main/docs/reference/api.md)
- [Errors and recovery](https://github.com/timescale/searchgres/blob/main/docs/reference/errors.md)
- [Direct SQL](https://github.com/timescale/searchgres/blob/main/docs/reference/sql.md)

## License

[Apache 2.0](https://github.com/timescale/searchgres/blob/main/LICENSE)

searchgres is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See the
[NOTICE](https://github.com/timescale/searchgres/blob/main/NOTICE).
