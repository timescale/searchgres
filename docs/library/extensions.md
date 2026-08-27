# Extensions and schemas

searchgres requires three PostgreSQL extensions:

| Extension | Purpose |
| --- | --- |
| `vector` | `vector` / `halfvec` types and HNSW cosine indexes |
| `pg_textsearch` | BM25 index access method |
| `ltree` | Hierarchical tree paths and GiST indexes |

`pg_textsearch` must be loaded through `shared_preload_libraries` before
PostgreSQL starts.

## Public-only

searchgres is opinionated: all three extensions must live in the `public`
schema. This keeps every extension object referenced with a fixed `public`
qualifier and avoids schema-discovery complexity.

`createIndex()` provisions any missing extension into `public`:

```sql
create extension if not exists vector with schema public;
create extension if not exists pg_textsearch with schema public;
create extension if not exists ltree with schema public;
```

If a required extension already exists in a schema other than `public`,
`createIndex()` and `openIndex()` reject it with an `ExtensionError`
(`reason: "wrong_schema"`) rather than moving it — relocating a database-wide
extension is an invasive operation searchgres will not perform for you. Install
the extension in `public`, or recreate it there, before using searchgres.

The index then uses these fixed objects:

```text
public.halfvec(1536)
public.halfvec_cosine_ops
public.ltree
```

> Supporting extensions in arbitrary schemas may be revisited later; if added, it
> would be a new immutable schema format (the routine bodies embed the qualified
> references), so existing indexes would need to be recreated.

## Controlled search path

Normal searchgres SQL fully qualifies extension objects with `public` and does
not persistently change the caller pool's `search_path`.

There are two controlled uses of a fixed `pg_catalog, public, pg_temp` path so
PostgreSQL can resolve extension-defined equality operators:

1. `createIndex()` sets a transaction-local path while it creates trigger `WHEN`
   expressions.
2. The integrity trigger and `batch_upsert` routine declare the equivalent
   function-local path for their bodies.

Both revert automatically and do not leak onto the caller pool.
