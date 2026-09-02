# searchgres documentation

searchgres is a Postgres-native search library for TypeScript. It gives you
semantic (vector), keyword (BM25), and hybrid retrieval — with composable
hierarchy, metadata, temporal, and regex filters — over a PostgreSQL database
you own and run.

New here? Start with **[Get started](getting-started.md)** for a working search
in a few minutes.

## Learn searchgres

1. **[Get started](getting-started.md)** — from an empty database to your first
   semantic and hybrid results.
2. **[Install searchgres](installation.md)** — executables, packages,
   prerequisites, and PostgreSQL setup.
3. **[Evaluate with Docker Compose](guides/docker-compose.md)** — run PostgreSQL,
   Ollama, provisioning, and the API server with one command and no API key.

## Guides

- **[Create and manage indexes](guides/indexes.md)** — choose dimensions and a
  vector type, create and open an index, and rebuild safely.
- **[Ingest records](guides/ingest.md)** — write one record or thousands,
  idempotent upserts, named records, metadata, and temporal values.
- **[Generate embeddings](guides/embeddings.md)** — how records become
  semantically searchable, draining on demand, and running a worker.
- **[Search and filter](guides/search.md)** — semantic, keyword, and hybrid
  search, composable filters, and pagination.
- **[Manage records and trees](guides/records-and-trees.md)** — read, patch,
  delete, subtree operations, and transactions.
- **[Configure and run the API server](guides/server.md)** — generate files
  offline, initialize PostgreSQL, serve, and use strict idempotent provisioning.
- **[Evaluate with Docker Compose](guides/docker-compose.md)** — start the
  five-service local demo, use it, restart it, and reset its persistent state.
- **[Run in production](guides/production.md)** — deployment, pooling, worker
  operations, monitoring, and reindex cutovers.
- **[Use the MCP server](mcp/index.md)** — run `searchgres-mcp` over stdio and understand
  its read, write, projection, and safety boundaries.

## Reference

- **[API reference](reference/api.md)** — every public function, option, and
  return type.
- **[Errors and recovery](reference/errors.md)** — the typed error hierarchy and
  how to handle each case.
- **[Direct SQL](reference/sql.md)** — optional: call the index's SQL routines
  without the TypeScript library.

## Core ideas

- **You own the database and the connection.** You pass searchgres a
  [`postgres.js`](https://github.com/porsager/postgres) pool; it never opens or
  closes connections for you.
- **An index is a PostgreSQL schema.** You choose its name and track it; there is
  no hidden registry.
- **Bring your own embedding model.** searchgres calls any
  [AI SDK](https://sdk.vercel.ai) embedding model you supply and never touches
  your provider credentials.
- **Embedding is asynchronous by default.** A new or changed record is searchable
  by keyword and filters immediately, and by semantic search once its vector is
  generated.
