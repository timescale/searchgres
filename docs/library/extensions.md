# Extensions and schemas

searchgres requires three PostgreSQL extensions:

| Extension | Purpose |
| --- | --- |
| `vector` | `vector` / `halfvec` types and HNSW cosine indexes |
| `pg_textsearch` | BM25 index access method |
| `ltree` | Hierarchical tree paths and GiST indexes |

`pg_textsearch` must be loaded through `shared_preload_libraries` before
PostgreSQL starts.

## Installation

`createIndex()` ensures missing extensions during provisioning. Its current
default installation schema is `public`.

Existing extensions may live in non-public schemas. searchgres discovers their
actual schemas from PostgreSQL catalogs and uses those schemas when creating and
opening an index.

For example, an administrator may preinstall extensions like this:

```sql
create schema vector_ext;
create schema textsearch_ext;
create schema ltree_ext;

create extension vector with schema vector_ext;
create extension pg_textsearch with schema textsearch_ext;
create extension ltree with schema ltree_ext;
```

`createIndex()` then creates the expected qualified objects:

```text
vector_ext.halfvec(1536)
vector_ext.halfvec_cosine_ops
ltree_ext.ltree
```

The implementation has an integration test that provisions all three extensions
in separate non-public schemas and verifies creation, opening, conflict handling,
and both embedding write paths.

## Controlled search paths

Normal searchgres SQL fully qualifies extension objects and does not persistently
change the caller pool's `search_path`.

There are two controlled exceptions needed for PostgreSQL to resolve
extension-defined equality operators:

1. `createIndex()` sets a transaction-local path while it creates trigger `WHEN`
   expressions.
2. The integrity trigger function has the equivalent function-local path for its
   body.

Both paths contain only `pg_catalog`, the controlled index/extension schemas, and
`pg_temp`; they revert automatically and do not leak onto the caller pool.
