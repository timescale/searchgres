import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import {
  ConflictError,
  DimensionMismatchError,
  InvalidConfigError,
  NotFoundError,
  StaleVersionError,
} from "../src/errors.ts";
import { type Index, openIndex } from "../src/open-index.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import { mockEmbeddingModel } from "./support/embedding.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(fn: (index: Index) => Promise<void>): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, {
      embedding: mockEmbeddingModel({}),
    });
    await fn(index);
  } finally {
    await dropTestSchema(sql, schema);
  }
}

test("get and getByName return the full record or throw NotFound", async () => {
  await withIndex(async (index) => {
    const created = await index.upsert({
      content: "hello",
      tree: "docs.api",
      name: "intro",
      meta: { source: "runbook" },
      temporal: ["2026-01-02T03:04:05.678Z"],
    });

    const byId = await index.get(created.id);
    assert.equal(byId.id, created.id);
    assert.equal(byId.content, "hello");
    assert.equal(byId.tree, "docs.api");
    assert.equal(byId.name, "intro");
    assert.deepEqual(byId.meta, { source: "runbook" });
    assert.equal(byId.hasEmbedding, false);
    assert.equal(byId.version, "1");
    assert.match(byId.versionHash, /^[a-f0-9]{32}$/);
    assert.ok(byId.createdAt instanceof Date);

    const byName = await index.getByName("docs.api", "intro");
    assert.equal(byName.id, created.id);

    await assert.rejects(
      () => index.get("019ce89d-f8b4-7000-8000-000000000000"),
      NotFoundError,
    );
    await assert.rejects(
      () => index.getByName("docs.api", "missing"),
      NotFoundError,
    );
    await assert.rejects(() => index.get("not-a-uuid"), InvalidConfigError);
  });
});

test("patch updates fields, returns the record, and enforces optimistic concurrency", async () => {
  await withIndex(async (index) => {
    const created = await index.upsert({
      content: "first",
      tree: "docs",
      name: "entry",
      meta: { revision: 1 },
    });
    const before = await index.get(created.id);

    const updated = await index.patch(created.id, before.versionHash, {
      content: "second",
      meta: { revision: 2 },
    });
    assert.equal(updated.content, "second");
    assert.deepEqual(updated.meta, { revision: 2 });
    assert.equal(updated.version, "2");
    assert.notEqual(updated.versionHash, before.versionHash);

    // stale hash → StaleVersionError
    await assert.rejects(
      () => index.patch(created.id, before.versionHash, { content: "third" }),
      StaleVersionError,
    );
    // unknown id → NotFoundError
    await assert.rejects(
      () =>
        index.patch(
          "019ce89d-f8b4-7000-8000-000000000000",
          updated.versionHash,
          { content: "x" },
        ),
      NotFoundError,
    );
    // empty patch → InvalidConfigError
    await assert.rejects(
      () => index.patch(created.id, updated.versionHash, {}),
      InvalidConfigError,
    );
  });
});

test("patch clears name, moves tree, and rejects a name collision", async () => {
  await withIndex(async (index) => {
    const a = await index.upsert({ content: "a", tree: "docs", name: "dup" });
    await index.upsert({ content: "b", tree: "docs", name: "keep" });
    const head = await index.get(a.id);

    // clear the name
    const cleared = await index.patch(a.id, head.versionHash, { name: null });
    assert.equal(cleared.name, null);

    // renaming onto an occupied (tree, name) slot conflicts
    await assert.rejects(
      () => index.patch(a.id, cleared.versionHash, { name: "keep" }),
      ConflictError,
    );
  });
});

test("patch can replace the embedding atomically with content", async () => {
  await withIndex(async (index) => {
    const created = await index.upsert({ content: "v1", tree: "docs" });
    await index.processEmbeddings(); // leaves a completed queue row; embedding still null (mock returns zeros)
    const head = await index.get(created.id);

    const updated = await index.patch(created.id, head.versionHash, {
      content: "v2",
      embedding: [1, 0, 0, 0],
    });
    assert.equal(updated.hasEmbedding, true);
    assert.equal(updated.content, "v2");

    // wrong dimension is rejected
    await assert.rejects(
      () =>
        index.patch(created.id, updated.versionHash, { embedding: [1, 0, 0] }),
      DimensionMismatchError,
    );
  });
});

test("delete and deleteByName remove a record or throw NotFound", async () => {
  await withIndex(async (index) => {
    const a = await index.upsert({ content: "a", tree: "docs", name: "one" });
    const b = await index.upsert({ content: "b", tree: "docs" });

    await index.deleteByName("docs", "one");
    await assert.rejects(() => index.get(a.id), NotFoundError);

    await index.delete(b.id);
    await assert.rejects(() => index.get(b.id), NotFoundError);

    await assert.rejects(() => index.delete(b.id), NotFoundError);
    await assert.rejects(
      () => index.deleteByName("docs", "one"),
      NotFoundError,
    );
  });
});

test("moveTree rewrites the subtree prefix and preserves records", async () => {
  await withIndex(async (index) => {
    const root = await index.upsert({ content: "root", tree: "a" });
    const child = await index.upsert({ content: "child", tree: "a.b.c" });
    await index.upsert({ content: "other", tree: "z" });

    const preview = await index.moveTree("a", "x.y", { dryRun: true });
    assert.equal(preview.count, 2);
    // dry run changed nothing
    assert.equal((await index.get(root.id)).tree, "a");

    const moved = await index.moveTree("a", "x.y");
    assert.equal(moved.count, 2);
    assert.equal((await index.get(root.id)).tree, "x.y");
    assert.equal((await index.get(child.id)).tree, "x.y.b.c");
  });
});

test("copyTree duplicates the subtree with fresh ids and keeps the source", async () => {
  await withIndex(async (index) => {
    const src = await index.upsert({
      content: "doc",
      tree: "src",
      name: "readme",
    });

    const copied = await index.copyTree("src", "dst");
    assert.equal(copied.count, 1);

    // source retained
    assert.equal((await index.get(src.id)).tree, "src");
    // copy addressable at the new path with a distinct id
    const copy = await index.getByName("dst", "readme");
    assert.notEqual(copy.id, src.id);
    assert.equal(copy.content, "doc");

    // a second copy collides on (dst, readme)
    await assert.rejects(() => index.copyTree("src", "dst"), ConflictError);
  });
});

test("deleteTree removes the inclusive subtree and cascades queue rows", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "1", tree: "docs.api" },
      { content: "2", tree: "docs.api.auth" },
      { content: "3", tree: "blog" },
    ]);
    assert.equal((await index.queueStats()).pending, 3);

    const preview = await index.deleteTree("docs", { dryRun: true });
    assert.equal(preview.count, 2);

    const deleted = await index.deleteTree("docs");
    assert.equal(deleted.count, 2);
    assert.equal((await index.countTree({ tree: "docs" })).count, 0);
    // queue rows for the deleted records cascaded
    assert.equal((await index.queueStats()).pending, 1);
  });
});

test("countTree supports each filter kind and reports capping", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "1", tree: "docs.api" },
      { content: "2", tree: "docs.api.auth" },
      { content: "3", tree: "docs.guide" },
    ]);

    assert.equal((await index.countTree({ tree: "docs" })).count, 3);
    assert.equal((await index.countTree({ tree: "docs.api" })).count, 2);
    assert.equal((await index.countTree({ lquery: "docs.*" })).count, 3);
    assert.equal((await index.countTree({ ltxtquery: "auth" })).count, 1);

    const capped = await index.countTree({ tree: "docs" }, { limit: 2 });
    assert.deepEqual(capped, { count: 2, capped: true });
    const exact = await index.countTree({ tree: "docs" }, { limit: 3 });
    assert.deepEqual(exact, { count: 3, capped: false });

    await assert.rejects(
      () => index.countTree({} as never),
      InvalidConfigError,
    );
  });
});

test("listTree aggregates descendant counts per ancestor node", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "1", tree: "docs.api.auth" },
      { content: "2", tree: "docs.api.rate" },
      { content: "3", tree: "docs.guide" },
    ]);

    const nodes = await index.listTree("docs.*");
    const byTree = new Map(nodes.map((n) => [n.tree, n.count]));
    assert.equal(byTree.get("docs"), 3);
    assert.equal(byTree.get("docs.api"), 2);
    assert.equal(byTree.get("docs.api.auth"), 1);
    assert.equal(byTree.get("docs.guide"), 1);
  });
});

test("with(tx) composes operations atomically and rolls back on throw", async () => {
  await withIndex(async (index) => {
    const created = await index.upsert({ content: "keep", tree: "docs" });

    // rollback: the patch inside a failing transaction must not persist
    await assert.rejects(
      sql.begin(async (tx) => {
        const t = index.with(tx);
        const head = await t.get(created.id);
        await t.patch(created.id, head.versionHash, { content: "changed" });
        throw new Error("abort");
      }),
      /abort/,
    );
    assert.equal((await index.get(created.id)).content, "keep");

    // commit: composed operations persist together
    await sql.begin(async (tx) => {
      const t = index.with(tx);
      const head = await t.get(created.id);
      await t.patch(created.id, head.versionHash, { content: "committed" });
      await t.upsert({ content: "sibling", tree: "docs", name: "sib" });
    });
    assert.equal((await index.get(created.id)).content, "committed");
    assert.equal((await index.getByName("docs", "sib")).content, "sibling");
  });
});

test("dropIndex removes the schema and rejects non-searchgres schemas", async () => {
  const schema = randomTestSchema();
  const plain = randomTestSchema();
  await createIndex(sql, schema, { dimensions: 4 });
  const index = await openIndex(sql, schema, {
    embedding: mockEmbeddingModel({}),
  });

  await sql`create schema ${sql(plain)}`;
  try {
    await assert.rejects(() =>
      openIndex(sql, plain, {
        embedding: mockEmbeddingModel({}),
      }),
    );
    // drop() on a real index succeeds
    await index.drop();
    const [row] = await sql<{ present: boolean }[]>`
      select exists (
        select 1 from pg_catalog.pg_namespace where nspname = ${schema}
      ) as present`;
    assert.equal(row?.present, false);
  } finally {
    await dropTestSchema(sql, plain);
    await dropTestSchema(sql, schema);
  }
});

test("record and tree routines are callable directly from SQL", async () => {
  await withIndex(async (index) => {
    const created = await index.upsert({
      content: "direct",
      tree: "docs",
      name: "x",
    });
    const s = index.schema;

    const got = await sql<{ id: string; content: string }[]>`
      select id, content from ${sql(s)}.get_record(${created.id})`;
    assert.equal(got[0]?.content, "direct");

    const moved = await sql<{ n: string }[]>`
      select ${sql(s)}.move_tree('docs'::public.ltree, 'archive'::public.ltree, false) as n`;
    assert.equal(Number(moved[0]?.n), 1);

    const count = await sql<{ n: string }[]>`
      select ${sql(s)}.count_tree('archive'::public.ltree, null) as n`;
    assert.equal(Number(count[0]?.n), 1);
  });
});
