# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Pre-release development. Nothing published yet.

### Added

- Project scaffolding: license, notice, readme, npm workspace, TypeScript 7
  build, runtime-portability lint rules, and cross-runtime package smoke tests.
- Initial public core primitives: typed errors and Zod-backed schema, ltree, and
  index-creation validation with inferred TypeScript types, structured
  validation issues, and pgvector, pg_textsearch, and HNSW defaults and bounds.
- Database plumbing: PostgreSQL 18 preflight, serialized extension installation
  and schema discovery, transaction-local migration timeouts, SQL spans, typed
  timeout/extension failures, Docker-backed integration tests, and CI coverage.
- Immutable schema provisioning: one atomic `createIndex` flow, singleton format
  marker, record and queue schemas, configured search indexes, and
  integrity/enqueue triggers that protect asynchronous embedding for direct SQL
  writers. Existing schemas are rebuilt rather than migrated in place.
- Core builds clean emitted artifacts first, preventing deleted source modules
  from remaining in published tarballs.
- Catalog-derived `openIndex` validation with immutable schema-format checks,
  required embedding models, and vector/HNSW shape inspection.
- Bulk `Index.upsertMany` and single-record `Index.upsert` writes with validated
  record inputs, conflict handling, precomputed embeddings, and queue-safe
  replacement behavior.
- UUIDv7 enforcement for supplied and direct record IDs, plus concurrency-safe
  skipped-conflict result resolution.
- Writes execute through a schema-local `batch_upsert` PL/pgSQL routine created
  with the index and callable directly from SQL; its body is part of the
  immutable schema format. The library validates inputs, calls the routine, and
  maps its conflict/validation SQLSTATEs to typed errors.
- Extensions are now public-only: `vector`, `pg_textsearch`, and `ltree` must
  live in `public`. `createIndex` installs missing ones there and rejects any
  installed in another schema (`ExtensionError` `reason: "wrong_schema"`).
  Bulk-write arrays are passed as bare parameters coerced by the routine
  signature, removing the previous manual PostgreSQL array-literal encoding.
- `Index.search` for filter-only, keyword (BM25), semantic (cosine), and hybrid
  (RRF) retrieval. The mode is inferred from the supplied arms (`semantic` or
  `vector`, and/or `fulltext`); there is no `mode` field. Filters are a composable
  boolean AST (`and`/`or`/`not` over `tree`, `lquery`, `ltxtquery`, `meta`,
  `metaPredicate`, temporal, and `regexp` leaves) applied to every mode. Results
  are always the full record plus a score. Filter-only listing supports `order`
  and `after`/`before` keyset paging; ranked search is fused top-k.
- Search executes through schema-local `search_records`, `hybrid_search_records`,
  and `compile_filter` PL/pgSQL routines created with the index and callable
  directly from SQL; their bodies are part of the immutable schema format. Filter
  values are always bound data, never interpolated into SQL. The BM25
  positive-match invariant and HNSW iterative strict-order scan are preserved, and
  a `regexp` may not be the sole filter criterion.
- Caller-supplied `Truncator` (`truncate` option on `openIndex`, default
  `noTruncation`) with `truncateCharacters`, `truncateBytes`, and `truncateTokens`
  built-ins, applied to semantic query text before embedding.
- Asynchronous embedding engine: `Index.processEmbeddings()` drains the queue in
  a bounded pass; `Index.startEmbeddingWorker()` runs a continuous, concurrency-
  safe drainer whose `stop()` finishes the in-flight batch and never closes the
  caller's pool; `Index.queueStats()` and `Index.pruneEmbeddingQueue()` inspect
  and maintain the queue. The queue is the retry authority: claims use `for
  update skip locked` with a lease, write-back is version-guarded so a stale
  vector can never overwrite a newer one, ordinary failures retry until
  `maxAttempts`, and rate limits / wrong dimensions release the work and throw.
  Durations are milliseconds (`leaseDurationMs`, `maxAttempts`,
  `pruneRetentionMs`); batch size is clamped to the model's `maxEmbeddingsPerCall`.
- The record integrity trigger now treats `content_version` as the embedding-
  input fence: it advances when the content or the stored vector changes, so a
  precomputed vector supplied after enqueue invalidates the stale queue row. The
  enqueue trigger fires on content-or-embedding changes that leave the row
  needing a vector, and covers direct SQL writers.
