import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
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

async function withSeededIndex(
  fn: (index: Index, ids: string[]) => Promise<void>,
): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, {
      embedding: mockEmbeddingModel({}),
    });
    const rows = await index.upsertMany([
      { content: "a", tree: "docs.api.auth", name: "one" },
      { content: "b", tree: "docs.api.rate" },
      { content: "c", tree: "docs.guide", name: "two" },
    ]);
    await fn(
      index,
      rows.map((r) => r.id),
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
}

test("stable read routines are correct under a hostile search_path", async () => {
  await withSeededIndex(async (index, ids) => {
    const firstId = ids[0];
    assert.ok(firstId);
    const evilSchema = randomTestSchema();
    // An attacker schema placed first on search_path, exporting `=` operators
    // that always return true. If any read routine left a built-in `=`
    // unqualified, these would shadow pg_catalog's and corrupt results; and by
    // excluding `public` we also prove the ltree objects are public-qualified.
    await sql`create schema ${sql(evilSchema)}`;
    await sql`
      create function ${sql(evilSchema)}.always_true(uuid, uuid)
      returns boolean language sql immutable as 'select true'`;
    await sql`
      create operator ${sql(evilSchema)}.= (
        function = ${sql(evilSchema)}.always_true, leftarg = uuid, rightarg = uuid
      )`;
    await sql`
      create function ${sql(evilSchema)}.always_true(text, text)
      returns boolean language sql immutable as 'select true'`;
    await sql`
      create operator ${sql(evilSchema)}.= (
        function = ${sql(evilSchema)}.always_true, leftarg = text, rightarg = text
      )`;

    // A fresh connection so the SQL function bodies are first parsed under the
    // hostile path (plan caching is per session).
    const hostile = connect();
    try {
      await hostile.unsafe(`set search_path to ${evilSchema}, pg_catalog`);

      // get_record: the bogus uuid `=` must not turn a miss into a match.
      const miss = await hostile`
        select id from ${hostile(index.schema)}.get_record('019ce89d-f8b4-7000-8000-000000000000')`;
      assert.equal(miss.length, 0);
      const hit = await hostile`
        select id from ${hostile(index.schema)}.get_record(${firstId})`;
      assert.equal(hit.length, 1);

      // get_record_by_name: bogus text `=` must not match the wrong name.
      const wrongName = await hostile`
        select id from ${hostile(index.schema)}.get_record_by_name('docs.api.auth'::public.ltree, 'nope')`;
      assert.equal(wrongName.length, 0);
      const rightName = await hostile`
        select id from ${hostile(index.schema)}.get_record_by_name('docs.api.auth'::public.ltree, 'one')`;
      assert.equal(rightName.length, 1);

      // count_tree and list_tree still resolve their public + pg_catalog objects.
      const count = await hostile<{ n: string }[]>`
        select ${hostile(index.schema)}.count_tree('docs'::public.ltree, null) as n`;
      assert.equal(Number(count[0]?.n), 3);

      const nodes = await hostile<{ tree: string; count: string }[]>`
        select tree, count from ${hostile(index.schema)}.list_tree('docs.*'::public.lquery)`;
      const byTree = new Map(nodes.map((n) => [n.tree, Number(n.count)]));
      assert.equal(byTree.get("docs"), 3);
      assert.equal(byTree.get("docs.api"), 2);
    } finally {
      await hostile.end();
      await dropTestSchema(sql, evilSchema);
    }
  });
});

test("get_record and list_tree are inlined into the calling plan", async () => {
  await withSeededIndex(async (index, ids) => {
    const firstId = ids[0];
    assert.ok(firstId);
    const getPlan = await sql.unsafe(
      `explain select * from ${index.schema}.get_record('${firstId}')`,
    );
    const getText = getPlan.map((r) => r["QUERY PLAN"]).join("\n");
    // Inlined → a scan on the record table, not an opaque Function Scan.
    assert.doesNotMatch(getText, /Function Scan on get_record/);
    assert.match(getText, /record/);

    const listPlan = await sql.unsafe(
      `explain select * from ${index.schema}.list_tree('docs.*'::public.lquery)`,
    );
    const listText = listPlan.map((r) => r["QUERY PLAN"]).join("\n");
    assert.doesNotMatch(listText, /Function Scan on list_tree/);
    assert.match(listText, /record/);
  });
});
