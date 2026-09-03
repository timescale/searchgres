# Choosing searchgres

searchgres is a good fit when you want a TypeScript library to provide strong
hybrid and structured retrieval over PostgreSQL you control. It is not a hosted
vendor or a complete RAG framework; it is the search engine you compose into
those systems.

## Compared with raw pgvector

`pgvector` provides vector types, operators, and indexes. It does not define a
complete retrieval application.

searchgres adds:

- BM25 through `pg_textsearch`;
- RRF fusion of lexical and semantic rankings;
- tree, metadata, temporal, and regex filters;
- an indexed record model and schema-local routines;
- embedding generation, queueing, retries, and concurrency control;
- validation, typed errors, and OpenTelemetry instrumentation.

Use raw pgvector when a single vector query and your own schema are all you
need. Use searchgres when you would otherwise build and maintain the surrounding
retrieval engine yourself.

## Compared with a vector database

Vector databases are optimized for nearest-neighbor search and can out-scale
searchgres when the central problem is searching an enormous vector collection.
But vector scale is only one axis of a search system, and many applications do
not need billions of vectors. They need more ways to express relevance.

A vector database primarily answers “which embeddings are closest?” searchgres
makes vectors one part of a broader retrieval model:

- BM25 finds exact terms, identifiers, and phrases that semantic similarity can
  miss;
- RRF combines lexical and semantic rankings without mixing incompatible score
  scales;
- hierarchy, JSON metadata, represented time, and regex constrain both ranking
  paths in the same query;
- filter-only search supports browsing and synchronization without inventing a
  vector query.

For many application and RAG workloads, that flexibility can matter more to
search quality than specialized vector scale. The benchmark architecture behind
searchgres used this combination to produce strong retrieval with a deliberately
simple data model.

The operational substrate is also a major difference. PostgreSQL is a mature,
popular relational database with real SQL and a widely understood ecosystem for
transactions, backups, replication, monitoring, access control, and incident
response. With searchgres you get:

- one transactional database and backup system;
- no synchronization between relational and vector stores;
- direct SQL access to ordinary records and schema-local routines;
- PostgreSQL's hierarchy, JSON, and temporal types and indexes;
- deployment, provider, and data ownership.

Choose a specialized vector database when extreme vector scale is the dominant
requirement. Choose searchgres when you want excellent hybrid and structured
retrieval, SQL, and familiar PostgreSQL operations—and your workload fits on
Postgres.

searchgres requires PostgreSQL 18 with `pgvector`, `pg_textsearch`, and `ltree`
available in `public`.

## Compared with a hosted search service

searchgres is a library, but it can power a hosted or internal search API. The
included server demonstrates one arrangement, and your application can expose
another.

Choose a turnkey hosted service when you want a vendor to own all database and
search operations. Choose searchgres when owning PostgreSQL, model selection,
and application policy is a benefit rather than a burden.

## Compared with a RAG framework

A RAG framework may orchestrate loaders, chunkers, retrievers, prompts, models,
and generation chains. searchgres focuses on retrieval.

It does not require a particular:

- chunking strategy,
- generation model,
- agent framework,
- prompt format,
- fact-extraction pipeline,
- reranker.

Use it as the retriever inside your framework, or call it directly from a small
application. The [RAG guide](guides/rag.md) shows the latter.

## Compared with an agent-memory system

Memory products often decide what to remember, extract facts from conversations,
build profiles, or maintain an application-specific memory lifecycle.
searchgres does none of that automatically.

It can store conversation turns, facts, summaries, decisions, or any other
textual record, but your application decides what those records mean. The
hierarchy, metadata, temporal model, and retrieval modes provide primitives for
building memory or context systems without limiting the library to that use
case.

## Compared with a search server

The core runs in the same process as your application and accepts a caller-owned
`postgres.js` pool. This gives you direct types, transactions, and no network
boundary.

When processes or languages need remote access, put an API around it. You can
use the included server/client or build a domain-specific service with enforced
filters and response shaping.

## Current core boundaries

- PostgreSQL 18 and the three required extensions are mandatory.
- Data must be represented as records in a searchgres index, although SQL,
  triggers, CDC, or application jobs can populate it from existing tables.
- Chunking, fact extraction, summarization, and reranking are application stages,
  not core v1 features.
- Authentication and authorization are enforced by the surrounding application
  or database policy.
- One index has one immutable vector shape and should use one embedding space.

These boundaries keep the core focused while leaving higher-level workflows
composable.
