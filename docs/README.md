# searchgres documentation

searchgres is a Postgres-native search library for TypeScript. It combines BM25,
vector search, Reciprocal Rank Fusion, and structured filters over a PostgreSQL
index you own.

Bring a `postgres.js` connection and an AI SDK embedding model. searchgres
manages the schema, native indexes, query routines, and asynchronous embedding
workflow; your application retains control of its data model, provider, access
policy, and retrieval pipeline.

## Start here

1. **[Get started](getting-started.md)** — create an index, ingest records,
   generate embeddings, and run semantic, keyword, and hybrid searches.
2. **[How search works](concepts/how-search-works.md)** — understand BM25,
   vector retrieval, RRF, filters, scores, and candidate windows.
3. **[Model records](concepts/record-model.md)** — decide how content, trees,
   metadata, names, and temporal ranges represent your corpus.
4. **[Architecture and responsibilities](concepts/architecture.md)** — see what
   searchgres manages and what remains in your application.

Want to evaluate it without writing an application? Use the
**[Docker Compose stack](guides/docker-compose.md)** to run PostgreSQL, Ollama,
provisioning, and the optional API server with no provider key.

## Core library guides

- **[Install searchgres](installation.md)** — package, runtime, PostgreSQL,
  extensions, and privileges.
- **[Create and manage indexes](guides/indexes.md)** — dimensions, vector type,
  immutable index shape, multiple indexes, and cutovers.
- **[Ingest records](guides/ingest.md)** — batches, idempotency, derived records,
  and indexing existing data sources.
- **[Generate embeddings](guides/embeddings.md)** — queue lifecycle, on-demand
  draining, continuous workers, and monitoring.
- **[Search and filter](guides/search.md)** — retrieval recipes, composable
  filters, ranking controls, and pagination.
- **[Build a RAG retriever](guides/rag.md)** — use the library as the retrieval
  stage in an application-controlled RAG pipeline.
- **[Manage records and trees](guides/records-and-trees.md)** — read, patch,
  delete, subtree operations, and transactions.
- **[Run in production](guides/production.md)** — pools, workers, observability,
  access control, backups, and reindexing.

## Evaluation and examples

- **[Choosing searchgres](comparison.md)** — compare it with raw pgvector, vector
  databases, hosted search, RAG frameworks, and memory systems.
- **[Runnable examples](../examples/README.md)** — small core-library programs
  for basic search, RAG, document modeling, temporal search, and workers.

## Optional applications

The core library is the primary product. These applications are built on top of
it and can be used as reference implementations or as-is:

- **[API server](guides/server.md)** — expose one configured index over HTTP.
- **[Docker Compose evaluation](guides/docker-compose.md)** — try the server and
  search engine locally without an API key.
- **[MCP server](mcp/index.md)** — give MCP-compatible agents read and write
  tools over the API server.

## Reference

- **[API reference](reference/api.md)** — public functions, options, and return
  types.
- **[Errors and recovery](reference/errors.md)** — typed errors and responses.
- **[Direct SQL](reference/sql.md)** — call schema-local routines without the
  TypeScript API.

## Core ideas

- **You own the database and connection.** searchgres never creates or closes
  your pool.
- **An index is a PostgreSQL schema.** It contains ordinary records plus native
  BM25, HNSW, GiST, and GIN indexes.
- **Retrieval modes compose with filters.** Search by meaning, exact terms,
  hierarchy, metadata, represented time, and regex in one query.
- **Bring your own embedding model.** Any AI SDK embedding model works;
  searchgres does not handle provider credentials.
- **Embedding is asynchronous by default.** New records work with BM25 and
  filters immediately and join semantic results after queue processing.
- **Application policy stays outside core.** Chunking, derivation, reranking,
  authentication, and authorization can be composed around the library.
