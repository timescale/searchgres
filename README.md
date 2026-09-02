# searchgres

Postgres-native search for TypeScript. Semantic (vector), keyword (BM25), and
hybrid retrieval — with composable hierarchy, metadata, temporal, and regex
filters — over a PostgreSQL database you own and run.

> **Status: pre-release, under active development.** The core library, API
> server, client, CLI, and stdio MCP server are implemented. Expect breaking
> changes until `1.0`.

## Why searchgres

Most RAG stacks bolt a separate vector database onto the side of the database
that already holds your data, then reconcile two systems forever. searchgres
keeps retrieval where your data lives: real BM25 keyword search, HNSW vector
search, and rank fusion — all executed in Postgres, filtered by the same query.

- **Semantic, keyword, and hybrid** in one call, with the mode inferred from the
  arms you pass.
- **Filters that compose** — scope by tree path, JSONB metadata (containment or
  JSONPath), a time range, or a regex, combined with `and`/`or`/`not`.
- **Bring your own embedding model** — any [AI SDK](https://sdk.vercel.ai)
  provider or a custom implementation. searchgres never touches your credentials.
- **Your database, your connection** — you pass a
  [`postgres.js`](https://github.com/porsager/postgres) pool; the library never
  opens or closes it.
- **Async embedding built in** — writes are fast; records become semantically
  searchable as a queue is drained, by an in-process worker or on demand.
- **Runs anywhere JavaScript does** — Node, Bun, and Deno.

## Requirements

- **PostgreSQL 18** with three extensions in the `public` schema:
  [`pgvector`](https://github.com/pgvector/pgvector),
  [`pg_textsearch`](https://github.com/timescale/pg_textsearch), and `ltree`.
- **Node ≥ 22**, **Bun ≥ 1.4**, or **Deno ≥ 2.0**.

A Dockerfile that builds PostgreSQL 18 with all three extensions is included for
local development. See [Install searchgres](docs/installation.md).

## Install

```bash
npm install searchgres postgres @ai-sdk/openai   # or any AI SDK provider
```

## Quick start

```ts
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const sql = postgres(process.env.DATABASE_URL);

// Create an index (its own Postgres schema). dimensions must match your model.
await createIndex(sql, "docs_index", { dimensions: 1536 });

// Open it, supplying the embedding model.
const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

// Write records.
await index.upsertMany([
  { content: "Auth tokens rotate every 24 hours.", tree: "docs.auth" },
  { content: "Rate limits are 100 req/min per API key.", tree: "docs.api" },
]);

// Generate their embeddings (in production, run a worker instead).
await index.processEmbeddings();

// Search: semantic, keyword, or — passing both arms — hybrid.
const hits = await index.search({
  semantic: "how are request limits enforced?",
  fulltext: "rate limit",
  limit: 5,
});

for (const hit of hits) console.log(hit.score, hit.tree, hit.content);

await sql.end();
```

Full walkthrough: **[Get started](docs/getting-started.md)**.

## Product surfaces

Compiled binaries layer remote workflows over the same core:

- `sg-server` provisions and serves one configured index.
- `sg` provides records, trees, import/export, and search over HTTP.
- `sg-mcp` exposes twelve MCP tools over stdio. It talks only to `sg-server`,
  registers all tools by default, and accepts `--read-only` to omit mutations.

Generate server files offline, review them, and then initialize PostgreSQL:

```bash
sg-server config
sg-server init --config searchgres.yaml
sg-server serve --config searchgres.yaml
```

Use `init --if-not-exists` for strict idempotent provisioning: an existing index
is accepted only when it is a valid, shape-compatible Searchgres index. See the
[API server guide](docs/guides/server.md).

The MCP binary requires only `--server <url>` or `SEARCHGRES_URL`; it does not
read server config, dotenv, database credentials, or local import/export files.
See the [MCP server guide](docs/mcp/index.md).

## Documentation

- [Get started](docs/getting-started.md)
- [Install searchgres](docs/installation.md)
- [Create and manage indexes](docs/guides/indexes.md)
- [Ingest records](docs/guides/ingest.md)
- [Generate embeddings](docs/guides/embeddings.md)
- [Search and filter](docs/guides/search.md)
- [Manage records and trees](docs/guides/records-and-trees.md)
- [Configure and run the API server](docs/guides/server.md)
- [Run in production](docs/guides/production.md)
- [Use the MCP server](docs/mcp/index.md)
- [API reference](docs/reference/api.md) ·
  [Errors](docs/reference/errors.md) ·
  [Direct SQL](docs/reference/sql.md)

## License

[Apache 2.0](LICENSE)

searchgres is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See [NOTICE](NOTICE).
