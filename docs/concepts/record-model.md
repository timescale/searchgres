# Model records

A searchgres index stores **records**. One record is one independently
searchable unit of text plus orthogonal annotations for hierarchy, metadata, and
represented time.

searchgres does not prescribe what a record means. It can be a document chunk,
a support answer, an event, a source-code explanation, an extracted fact, a
conversation turn, or a generated summary.

## Record fields

| Field | Purpose |
| --- | --- |
| `content` | Text searched by BM25 and represented by the embedding |
| `tree` | Dotted hierarchy used for organization and subtree filtering |
| `meta` | JSON object used for facets and JSONPath predicates |
| `temporal` | Optional represented instant or time range |
| `name` | Optional stable name unique within a tree |
| `id` | UUIDv7 identity, generated when omitted |
| `embedding` | Optional caller-supplied vector |

Search results also include version fields, timestamps, and whether an embedding
is present.

## One record is one chunk

The core does not split documents. Choose boundaries that make each returned
record useful on its own:

- preserve headings or paragraphs rather than cutting solely by character count;
- include enough local context to interpret the passage;
- avoid records so large that every match returns unrelated material;
- retain source identity and position in `meta` or `name`;
- evaluate chunking against the questions your application actually asks.

A stable record address makes repeat ingestion idempotent:

```ts
await index.upsertMany(
  chunks.map((chunk, position) => ({
    tree: `docs.${document.slug}`,
    name: `chunk-${position}`,
    content: chunk.text,
    meta: {
      sourceId: document.id,
      heading: chunk.heading,
      position,
      revision: document.revision,
    },
  })),
  { onConflict: "replace" },
);
```

## Trees organize retrieval scope

`tree` is a raw dotted PostgreSQL `ltree` path such as:

```text
docs.api.authentication
tickets.customer_acme.open
research.models.embeddings
```

A `{ tree: "docs.api" }` filter matches that node and its descendants. Use trees
for stable, hierarchical scope: tenant, corpus, product area, document, speaker,
session, or lifecycle state when those concepts naturally form a hierarchy.

Trees are not automatically permissions. An application can enforce an access
scope by injecting an unavoidable tree filter, but callers with unrestricted
library or database access can bypass it.

## Metadata provides orthogonal facets

Use `meta` for dimensions that do not form a single hierarchy:

```ts
{
  source: "runbook",
  language: "en",
  audience: ["operators", "support"],
  revision: 7,
  current: true
}
```

JSONB containment handles exact subsets, while JSONPath handles predicates such
as numeric comparisons. Prefer fields with consistent names and value types;
metadata flexibility is most useful when producers share conventions.

Do not duplicate large source documents in metadata. Keep searchable text in
`content` and source blobs in their source system unless the metadata itself is
needed in results.

## Temporal means represented time

`createdAt` and `updatedAt` describe the database record. `temporal` describes
what its content represents.

- `[time]` stores a point event.
- `[start, end]` stores a half-open period `[start, end)`.

Examples include an incident window, policy validity, event occurrence, or the
period covered by a report. This distinction lets you ask whether records fall
within, overlap, occur before or after, or contain a query time.

## Raw and derived representations

Chunking, summarization, and fact extraction can happen before ingest. Derived
content is still just a record and can live:

- beside raw records under distinct tree branches;
- in the same document subtree with a `meta.kind` facet;
- or in a separate index when it needs a different model, dimensions, lifecycle,
  or retrieval policy.

For example:

```text
knowledge.raw.handbook.security
knowledge.summary.handbook.security
knowledge.facts.handbook.security
```

Preserving raw records alongside derived ones keeps the original evidence
available while allowing specialized representations.

## Indexing existing application tables

searchgres does not search arbitrary table layouts in place; its routines and
indexes operate on the index's `record` table. Existing data can feed that table
through:

- application code that reads source rows and calls `upsertMany()`;
- scheduled SQL that calls the index's `batch_upsert` routine;
- `AFTER INSERT OR UPDATE` triggers on source tables;
- change-data-capture consumers or job queues.

The searchgres record trigger populates the embedding queue whenever an inserted
or changed record needs a vector, including records written through direct SQL.
This allows a database-native indexing pipeline without putting provider
credentials in the source writer.

When using a source-table trigger, keep the trigger small and deterministic. A
common design is to project the source row into the searchgres record and let a
separate worker perform remote embedding calls asynchronously.

## Multiple indexes

Use one index when records share an embedding model and benefit from searching
across the same corpus. Use separate indexes when you need:

- different embedding models or dimensions;
- independent lifecycle or ownership;
- physical isolation;
- different BM25 language configuration;
- no cross-corpus retrieval.

An index is a caller-named PostgreSQL schema, so several indexes can share a
pool without sharing records.

Next: [Ingest records](../guides/ingest.md).
