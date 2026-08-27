import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { InvalidConfigError } from "../src/errors.ts";
import { type Index, openIndex } from "../src/open-index.ts";
import { truncateCharacters } from "../src/truncate.ts";
import { expectSqlState } from "./support/assert.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import { mockEmbeddingModel } from "./support/embedding.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(
  fn: (index: Index) => Promise<void>,
  options?: { embedding?: ReturnType<typeof mockEmbeddingModel> },
): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, {
      embedding: options?.embedding ?? mockEmbeddingModel({}),
    });
    await fn(index);
  } finally {
    await dropTestSchema(sql, schema);
  }
}

const contents = (results: readonly { content: string }[]): string[] =>
  results.map((r) => r.content).sort();

test("filter-only search lists records by id with order and keyset paging", async () => {
  await withIndex(async (index) => {
    const [a, b, c] = await index.upsertMany([
      { content: "first", tree: "docs" },
      { content: "second", tree: "docs" },
      { content: "third", tree: "docs" },
    ]);

    const desc = await index.search({});
    assert.deepEqual(
      desc.map((r) => r.content),
      ["third", "second", "first"],
    );
    assert.ok(desc.every((r) => r.score === -1));

    const asc = await index.search({ order: "asc" });
    assert.deepEqual(
      asc.map((r) => r.content),
      ["first", "second", "third"],
    );

    const page = await index.search({ order: "asc", after: a?.id, limit: 1 });
    assert.deepEqual(
      page.map((r) => r.content),
      ["second"],
    );
    assert.equal(page[0]?.id, b?.id);

    const back = await index.search({ order: "asc", before: c?.id, limit: 1 });
    // before c, ascending, limit 1 → the smallest id (first)
    assert.equal(back[0]?.id, a?.id);
  });
});

test("boolean filters compose with and/or/not", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "api runbook", tree: "docs.api", meta: { source: "runbook" } },
      { content: "api blog", tree: "docs.api", meta: { source: "blog" } },
      {
        content: "guide runbook",
        tree: "docs.guide",
        meta: { source: "runbook" },
      },
    ]);

    const and = await index.search({
      filter: { and: [{ tree: "docs.api" }, { meta: { source: "runbook" } }] },
    });
    assert.deepEqual(contents(and), ["api runbook"]);

    const or = await index.search({
      filter: { or: [{ tree: "docs.guide" }, { meta: { source: "blog" } }] },
    });
    assert.deepEqual(contents(or), ["api blog", "guide runbook"]);

    const not = await index.search({
      filter: {
        and: [{ tree: "docs.api" }, { not: { meta: { source: "blog" } } }],
      },
    });
    assert.deepEqual(contents(not), ["api runbook"]);
  });
});

test("each filter leaf type matches its records", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      {
        content: "tokens rotate hourly",
        tree: "docs.api.auth",
        meta: { source: "runbook", version: 3 },
        temporal: ["2026-01-10T00:00:00Z", "2026-01-20T00:00:00Z"],
      },
      { content: "unrelated", tree: "blog.news" },
    ]);

    const cases: Array<[string, Parameters<Index["search"]>[0]]> = [
      ["tree", { filter: { tree: "docs.api" } }],
      ["lquery", { filter: { lquery: "docs.*" } }],
      ["ltxtquery", { filter: { ltxtquery: "auth" } }],
      ["meta", { filter: { meta: { source: "runbook" } } }],
      ["metaPredicate", { filter: { metaPredicate: "$.version >= 3" } }],
      [
        "temporalWithin",
        {
          filter: {
            temporalWithin: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
          },
        },
      ],
      [
        "temporalOverlaps",
        {
          filter: {
            temporalOverlaps: ["2026-01-15T00:00:00Z", "2026-01-25T00:00:00Z"],
          },
        },
      ],
      [
        "temporalContains",
        { filter: { temporalContains: "2026-01-14T00:00:00Z" } },
      ],
      ["temporalAfter", { filter: { temporalAfter: "2026-01-05T00:00:00Z" } }],
      [
        "temporalBefore",
        { filter: { temporalBefore: "2026-01-25T00:00:00Z" } },
      ],
      [
        "regexp guarded",
        { filter: { and: [{ tree: "docs" }, { regexp: "rotate" }] } },
      ],
    ];

    for (const [label, options] of cases) {
      const results = await index.search(options);
      assert.deepEqual(
        contents(results),
        ["tokens rotate hourly"],
        `filter ${label} should match only the target`,
      );
    }
  });
});

test("keyword search returns only genuine positive BM25 matches", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "dragonfruit smoothie", tree: "a" },
      { content: "fresh dragonfruit cake", tree: "b" },
      { content: "banana muffin", tree: "c" },
    ]);

    const hits = await index.search({ fulltext: "dragonfruit", limit: 10 });
    assert.deepEqual(contents(hits), [
      "dragonfruit smoothie",
      "fresh dragonfruit cake",
    ]);
    assert.ok(hits.every((r) => r.score > 0));

    const none = await index.search({ fulltext: "zzznotaword" });
    assert.deepEqual(none, []);
  });
});

test("semantic search with a precomputed vector ranks by cosine and honors threshold", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "near", tree: "v", embedding: [1, 0, 0, 0] },
      { content: "mid", tree: "v", embedding: [1, 1, 0, 0] },
      { content: "far", tree: "v", embedding: [0, 1, 0, 0] },
      { content: "unembedded", tree: "v" },
    ]);

    const ranked = await index.search({ vector: [1, 0, 0, 0], limit: 10 });
    assert.deepEqual(
      ranked.map((r) => r.content),
      ["near", "mid", "far"],
    );
    const near = ranked.find((r) => r.content === "near");
    assert.ok(near && Math.abs(near.score - 1) < 1e-4);
    // null embeddings never participate in semantic retrieval
    assert.ok(!ranked.some((r) => r.content === "unembedded"));

    const thresholded = await index.search({
      vector: [1, 0, 0, 0],
      semanticThreshold: 0.5,
      limit: 10,
    });
    assert.deepEqual(
      thresholded.map((r) => r.content),
      ["near", "mid"],
    );
  });
});

test("semantic search embeds the query with the index model and truncator", async () => {
  const embedding = mockEmbeddingModel({ find: [1, 0, 0, 0] });
  await withIndex(
    async (index) => {
      await index.upsertMany([
        { content: "target", tree: "v", embedding: [1, 0, 0, 0] },
        { content: "other", tree: "v", embedding: [0, 1, 0, 0] },
      ]);

      // truncateCharacters(4) clips "find me" → "find" before embedding.
      const withTruncator = await openIndex(sql, index.schema, {
        embedding,
        truncate: truncateCharacters(4),
      });
      const results = await withTruncator.search({ semantic: "find me" });

      assert.equal(results[0]?.content, "target");
      assert.deepEqual(embedding.calls, ["find"]);
    },
    { embedding },
  );
});

test("hybrid search fuses both arms with RRF and applies filters to both", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "dragonfruit recipe", tree: "docs", embedding: [1, 0, 0, 0] },
      { content: "banana recipe", tree: "docs", embedding: [1, 0, 0, 0] },
      {
        content: "dragonfruit recipe elsewhere",
        tree: "blog",
        embedding: [1, 0, 0, 0],
      },
    ]);

    const hits = await index.search({
      fulltext: "dragonfruit",
      vector: [1, 0, 0, 0],
      filter: { tree: "docs" },
      limit: 10,
    });
    // filtered to docs; the row matching both arms ranks first.
    assert.equal(hits[0]?.content, "dragonfruit recipe");
    assert.ok(!hits.some((r) => r.tree === "blog"));
    assert.ok(hits.every((r) => r.score > 0));
  });
});

test("a regexp filter cannot be the sole criterion", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([{ content: "throttled", tree: "docs" }]);
    await assert.rejects(
      () => index.search({ filter: { regexp: "throttl" } }),
      InvalidConfigError,
    );
  });
});

test("the search routines are callable directly from SQL", async () => {
  await withIndex(async (index) => {
    const schema = index.schema;
    await index.upsertMany([
      { content: "dragonfruit direct", tree: "docs", embedding: [1, 0, 0, 0] },
    ]);

    const keyword = await sql<{ content: string; score: number }[]>`
      select content, score
      from ${sql(schema)}.search_records(_fulltext => ${"dragonfruit"})
    `;
    assert.equal(keyword[0]?.content, "dragonfruit direct");

    const compiled = await sql<{ compile_filter: string }[]>`
      select ${sql(schema)}.compile_filter(${sql.json({ tree: "docs" })}::jsonb, '$1', 1) as compile_filter
    `;
    assert.match(compiled[0]?.compile_filter ?? "", /operator\(public\.@>\)/);

    // A direct filter-only call with an unguarded regexp is rejected too.
    await expectSqlState(
      () => sql`
        select *
        from ${sql(schema)}.search_records(_filter => ${sql.json({ regexp: "x" })}::jsonb)
      `,
      "22023",
    );
  });
});
