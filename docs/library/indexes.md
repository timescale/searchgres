# Creating and opening indexes

An index is a literal PostgreSQL schema. The application tracks its index schema
names; searchgres does not provide index discovery.

## Create an index

```ts
import postgres from "postgres";
import { createIndex } from "searchgres";

const sql = postgres(process.env.DATABASE_URL!);

await createIndex(sql, "docs_index", {
  dimensions: 1536,
  vectorType: "halfvec",
  bm25: {
    textConfig: "english",
    k1: 1.2,
    b: 0.75,
  },
  hnsw: {
    m: 16,
    efConstruction: 64,
  },
});
```

Only `dimensions` is required. Defaults:

| Field | Default |
| --- | --- |
| `vectorType` | `"halfvec"` |
| `bm25.textConfig` | `"english"` |
| `bm25.k1` | `1.2` |
| `bm25.b` | `0.75` |
| `hnsw.m` | `16` |
| `hnsw.efConstruction` | `64` |

`createIndex()` is one transaction under one database-wide advisory lock. It:

1. Validates the schema name and creation configuration.
2. Ensures PostgreSQL 18 and the required extensions.
3. Rejects an existing schema with `ConflictError`.
4. Creates the schema, immutable version marker, record table, indexes, queue,
   and triggers.
5. Commits everything or rolls back the entire schema on failure.

## Immutable formats

Each index schema contains a singleton `version` table with the schema format
marker. The current format is `"1"`.

Schemas are immutable. `createIndex()` never upgrades an existing schema. When a
future DDL format is incompatible, create a new schema, reindex into it, then
retire the old one.

## Open an index

```ts
import { openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

console.log(index.schema);      // "docs_index"
console.log(index.vectorType);  // "vector" | "halfvec"
console.log(index.dimensions);  // 1536
```

The embedding model is required by `openIndex()` because later query and worker
operations use the handle. Opening does not call the provider and does not compare
model identity with stored data.

`openIndex()` reads and validates:

- the singleton format marker
- installed extension schemas and minimum versions
- the `record.embedding` PostgreSQL type and dimensions
- the HNSW access method and matching cosine opclass

Errors:

| Error | Meaning |
| --- | --- |
| `InvalidIndexError` | The schema has no valid searchgres version marker or required shape. |
| `SchemaVersionError` | The marker uses a schema format this library does not support. Create a new index and reindex. |
| `ExtensionError` | A required extension is missing, too old, unavailable, or inaccessible. |

Opening never runs DDL, installs extensions, or changes the caller pool's
persistent `search_path`.
