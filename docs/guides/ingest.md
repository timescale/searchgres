# Ingest records

A record is one unit of searchable content — one chunk. searchgres does not
split documents for you; the caller decides how to chunk.

## Write one record

```ts
const result = await index.upsert({
  content: "Authentication tokens rotate every 24 hours.",
  tree: "docs.auth",
  name: "token-rotation",
  meta: { source: "runbook", version: 3 },
});

result; // { id: "019ce89d-...", status: "inserted" }
```

## Write a batch

`upsertMany` writes up to 1,000 records in a single round trip and returns one
result per input, in order:

```ts
const results = await index.upsertMany([
  { content: "First chunk", tree: "docs.guide" },
  { content: "Second chunk", tree: "docs.guide" },
]);

for (const { id, status } of results) {
  console.log(id, status); // status: "inserted" | "updated" | "skipped"
}
```

Batches over 1,000 throw [`BatchTooLargeError`](../reference/errors.md); chunk
your input and call again.

## The record fields

```ts
type UpsertRecord = {
  content: string;                    // required — the searchable text
  tree?: string;                      // dotted ltree path; defaults to root ""
  name?: string | null;               // optional leaf name, unique within a tree
  meta?: Record<string, unknown>;     // arbitrary JSON, filterable
  temporal?:                          // a point in time, or a half-open interval
    | readonly [Date | string]
    | readonly [Date | string, Date | string];
  id?: string;                        // optional UUIDv7 (generated if omitted)
  embedding?: readonly number[];      // optional precomputed vector
};
```

- **`tree`** is a raw dotted `ltree` path such as `docs.api.auth`. Each label is
  `[A-Za-z0-9_-]+`. The empty string `""` is the root. Use it to scope searches
  later (see [Search and filter](search.md)).
- **`name`** makes a record addressable by `(tree, name)` and is its idempotency
  key (see below). Set it to `null` (the default) for anonymous records.
- **`meta`** is any JSON object; filter on it with containment or JSONPath.
- **`temporal`** stores represented time. A one-element tuple is a point stored as
  `[t, t]`; a two-element tuple is stored as the half-open interval `[start, end)`
  and requires `start < end`. Timestamp strings must include an offset or `Z`
  (e.g. `2026-01-01T00:00:00Z`); `Date` objects work too.
- **`id`** is generated as a UUIDv7 when omitted. A supplied id must be UUIDv7.
- **`embedding`** lets you supply a precomputed vector; see
  [Generate embeddings](embeddings.md).

## Conflicts and idempotency

The idempotency key is the record's `name` slot `(tree, name)` if it has a name,
otherwise its explicit `id`. An anonymous record (no name, no id) always inserts.

`onConflict` chooses what happens when that key already exists:

```ts
await index.upsert(record);                              // default: replace
await index.upsert(record, { onConflict: "error" });   // throw
await index.upsert(record, { onConflict: "ignore" });  // keep existing, skip
await index.upsert(record, { onConflict: "replace" }); // overwrite if changed

await index.insert(record);      // equivalent to upsert(..., { onConflict: "error" })
await index.insertMany(records); // same conflict behavior for a batch
```

- **`replace`** (default) updates in place, but only when a field actually
  differs; an identical replace reports `"skipped"`, so re-running an import is
  a no-op.
- **`error`** throws [`ConflictError`](../reference/errors.md) and rolls back the
  whole batch if any input conflicts. `insert` and `insertMany` always use it.
- **`ignore`** leaves the existing record and reports `"skipped"`.

### Idempotent document ingest

Give each source document a stable `(tree, name)` and use `replace`. Re-running
the import only rewrites what changed:

```ts
await index.upsertMany(
  chunks.map((chunk) => ({
    tree: `docs.${doc.slug}`,
    name: `chunk-${chunk.index}`,
    content: chunk.text,
    meta: { source: "docs", version: doc.version },
  })),
  { onConflict: "replace" },
);
```

### Import with stable ids

For migrations or cross-system identity, supply your own UUIDv7 ids. An unnamed
record keyed on its id is updated in place on `replace`:

```ts
await index.upsertMany(rows, { onConflict: "replace" });
```

Duplicate ids within a batch, duplicate `(tree, name)` keys, or a batch where an
id and a name resolve to the same existing record are rejected with
[`InvalidConfigError`](../reference/errors.md) before anything is written.

## When is a record searchable?

Immediately for keyword and filter queries. For **semantic** search a record
needs its vector, which is generated asynchronously unless you supply one. After
a bulk ingest, drain the queue (or run a worker) before expecting semantic
results:

```ts
await index.upsertMany(records);
await index.processEmbeddings();
```

See [Generate embeddings](embeddings.md) for the full lifecycle, including
supplying precomputed vectors.

Next: [Generate embeddings](embeddings.md).
