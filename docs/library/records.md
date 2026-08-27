# Records, tree operations, and lifecycle

Beyond writing and searching, an index handle exposes point reads, an
optimistic patch, deletes, subtree operations, transaction composition, and
schema drop.

## Reading a record

```ts
const record = await index.get(id);                    // by UUIDv7 id
const same = await index.getByName("docs.api", "intro"); // by (tree, name)
```

Both return the full record and throw `NotFoundError` if it does not exist:

```ts
type StoredRecord = {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  name: string | null;
  hasEmbedding: boolean;
  version: string;
  versionHash: string;
  createdAt: Date;
  updatedAt: Date | null;
};
```

## Patching a record

`patch` is optimistic: pass the `versionHash` you last read. It returns the
updated record.

```ts
const current = await index.get(id);
const updated = await index.patch(id, current.versionHash, {
  content: "new content",
  meta: { revision: 2 },
  // tree, name, temporal may also be set; name/temporal accept null to clear
  // embedding may be supplied to replace the vector atomically with content
});
```

- A missing row throws `NotFoundError`; a row changed since you read it throws
  `StaleVersionError` — the two are distinguished in a single round trip.
- Omit a key to leave it unchanged. Set `name`/`temporal` to `null` to clear.
- `tree` cannot be set to `null`. A rename/move onto an occupied `(tree, name)`
  slot throws `ConflictError`.
- A supplied `embedding` must match `index.dimensions`. The trigger advances the
  record's version fence so any queued/in-flight embedding for the old state is
  discarded rather than overwriting the supplied vector.
- An empty patch (no fields) throws `InvalidConfigError`.

## Deleting records

```ts
await index.delete(id);
await index.deleteByName("docs.api", "intro");
```

Both throw `NotFoundError` when nothing matched. Deleting a record cascades its
embedding-queue rows.

## Tree operations

Paths are raw dotted `ltree`. Subtree operations are inclusive (they include the
path itself and everything under it).

```ts
await index.moveTree("drafts", "published");   // rewrite the prefix in place
await index.copyTree("templates", "docs.new"); // duplicate as fresh records
await index.deleteTree("scratch");             // delete the subtree

// preview without changing anything
const { count } = await index.moveTree("a", "b", { dryRun: true });
```

- `moveTree`/`copyTree`/`deleteTree` return `{ count }` of affected rows and
  return `{ count: 0 }` for an empty subtree — they never throw `NotFoundError`.
- `copyTree` gives each copy a fresh id and re-derives its embedding (a copied
  non-null vector is kept; a null one is queued). The source is untouched.
- A destination `(tree, name)` collision throws `ConflictError` and rolls the
  whole operation back.

### Counting and listing

`countTree` takes exactly one explicit filter kind and an optional cap:

```ts
await index.countTree({ tree: "docs.api" });          // { count, capped }
await index.countTree({ lquery: "docs.*.api" });
await index.countTree({ ltxtquery: "api & v2" });
await index.countTree({ tree: "docs" }, { limit: 100 });
```

`capped` is `true` when the `limit` was reached, so `count` is a lower bound.

`listTree` returns each tree node matching an lquery with a descendant count (a
matching record contributes to every ancestor node):

```ts
for (const { tree, count } of await index.listTree("docs.*")) {
  console.log(tree, count);
}
```

## Composing in a transaction

`index.with(tx)` binds record and tree operations to a caller-owned
transaction so they commit or roll back together:

```ts
await sql.begin(async (tx) => {
  const t = index.with(tx);
  const head = await t.get(id);
  await t.patch(id, head.versionHash, { content: "updated" });
  await t.moveTree("drafts", "published");
});
```

The returned `TransactionIndex` exposes only record/tree/search/write methods.
Embedding-drain and queue methods are excluded: the worker owns multiple short
transactions around remote provider calls and must not run inside — or outlive —
a caller transaction. The caller owns commit, rollback, and the pool.

## Dropping an index

```ts
await index.drop();          // or
await dropIndex(sql, "docs_index");
```

This runs `drop schema … cascade` after verifying the schema is a searchgres
index. A non-searchgres schema throws `InvalidIndexError`. Any schema-format
version is droppable, so obsolete indexes remain removable.
