# Library

The `searchgres` package provisions and writes immutable PostgreSQL search index
schemas. An index is one caller-named PostgreSQL schema containing records,
indexes, embedding queue state, integrity triggers, and a singleton schema-format
marker.

## Current API

The following library capabilities are implemented:

- `createIndex()` provisions a new immutable index schema.
- `openIndex()` validates and opens an existing schema; `dropIndex()` /
  `Index.drop()` removes one.
- `Index.upsert()` writes one record.
- `Index.upsertMany()` writes up to 1,000 records in a bulk statement.
- `Index.search()` runs filter-only, keyword, semantic, or hybrid retrieval.
- `Index.get()` / `getByName()` read a record; `Index.patch()` updates one
  optimistically; `Index.delete()` / `deleteByName()` remove one.
- `Index.moveTree()` / `copyTree()` / `deleteTree()` / `countTree()` /
  `listTree()` operate on subtrees.
- `Index.processEmbeddings()` / `Index.startEmbeddingWorker()` drain the async
  embedding queue; `Index.queueStats()` / `Index.pruneEmbeddingQueue()` inspect
  and maintain it.
- `Index.with(tx)` binds record/tree operations to a caller transaction.

See [installation](installation.md), [index lifecycle](indexes.md),
[writing records](writes.md), [searching records](search.md),
[records and tree operations](records.md), and
[embeddings and the drain engine](embeddings.md).

## Not implemented yet

Transaction-bound handles cover record and tree operations; a reranker hook,
audit log, and `tsvector` fallback remain designed seams. The root README and
design documents describe the larger target API; this directory documents only
the public behavior available in the current implementation.

## Core principles

- You own the `postgres.js` pool. searchgres never calls `sql.end()`.
- The caller chooses the literal PostgreSQL schema name.
- Schemas are immutable by format. A future incompatible DDL format requires a
  new schema and reindexing; there is no in-place upgrade API.
- PostgreSQL is the source of truth for index shape. Vector type, dimensions,
  HNSW configuration, and extension placement are read from catalogs rather
  than duplicated in a config table.
- SQL writes are safe for direct producers as well as library calls. Database
  triggers preserve valid precomputed embeddings and queue null or unchanged
  embeddings for asynchronous processing.
