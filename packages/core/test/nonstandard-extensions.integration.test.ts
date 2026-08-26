import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import {
  columnType,
  connect,
  connectToDatabase,
  createTestDatabase,
  dropTestDatabase,
  extensionSchema,
  indexOpclassSchema,
  randomTestDatabase,
} from "./support/db.ts";

test("createIndex supports extensions installed outside public", async () => {
  const admin = connect();
  const database = randomTestDatabase();
  let indexSql: Sql | undefined;
  const vectorSchema = "sgtest_vector_ext";
  const textsearchSchema = "sgtest_textsearch_ext";
  const ltreeSchema = "sgtest_ltree_ext";
  const indexSchema = "docs";

  try {
    await createTestDatabase(admin, database);
    indexSql = connectToDatabase(database);

    await indexSql`create schema ${indexSql(vectorSchema)}`;
    await indexSql`create schema ${indexSql(textsearchSchema)}`;
    await indexSql`create schema ${indexSql(ltreeSchema)}`;
    await indexSql`create extension vector with schema ${indexSql(vectorSchema)}`;
    await indexSql`create extension pg_textsearch with schema ${indexSql(textsearchSchema)}`;
    await indexSql`create extension ltree with schema ${indexSql(ltreeSchema)}`;

    await createIndex(indexSql, indexSchema, { dimensions: 4 });

    assert.equal(await extensionSchema(indexSql, "vector"), vectorSchema);
    assert.equal(
      await extensionSchema(indexSql, "pg_textsearch"),
      textsearchSchema,
    );
    assert.equal(await extensionSchema(indexSql, "ltree"), ltreeSchema);
    assert.equal(
      await columnType(indexSql, indexSchema, "record", "embedding"),
      `${vectorSchema}.halfvec(4)`,
    );
    assert.equal(
      await columnType(indexSql, indexSchema, "record", "tree"),
      `${ltreeSchema}.ltree`,
    );
    assert.equal(
      await indexOpclassSchema(
        indexSql,
        indexSchema,
        "record_embedding_hnsw_idx",
      ),
      vectorSchema,
    );

    const embeddingType = indexSql`${indexSql(vectorSchema)}.${indexSql("halfvec")}`;
    const record = indexSql`${indexSql(indexSchema)}.record`;
    const queue = indexSql`${indexSql(indexSchema)}.embedding_queue`;
    const [precomputed] = await indexSql<
      {
        readonly id: string;
        readonly embedding: string | null;
        readonly content_version: number;
      }[]
    >`
      insert into ${record} (content, embedding)
      values (${"precomputed v1"}, ${"[1,0,0,0]"}::${embeddingType})
      returning id, embedding, content_version
    `;
    assert.ok(precomputed);
    assert.equal(precomputed.embedding, "[1,0,0,0]");
    assert.equal(precomputed.content_version, 1);

    const [precomputedUpdated] = await indexSql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
      }[]
    >`
      update ${record}
      set content = ${"precomputed v2"},
          embedding = ${"[0,1,0,0]"}::${embeddingType}
      where id = ${precomputed.id}
      returning embedding, content_version
    `;
    assert.ok(precomputedUpdated);
    assert.equal(precomputedUpdated.embedding, "[0,1,0,0]");
    assert.equal(precomputedUpdated.content_version, 2);
    const precomputedQueue = await indexSql`
      select id
      from ${queue}
      where record_id = ${precomputed.id}
    `;
    assert.deepEqual(Array.from(precomputedQueue), []);

    const [asynchronous] = await indexSql<
      { readonly id: string; readonly embedding: string | null }[]
    >`
      insert into ${record} (content)
      values (${"async v1"})
      returning id, embedding
    `;
    assert.ok(asynchronous);
    assert.equal(asynchronous.embedding, null);
    await indexSql`
      update ${record}
      set content = ${"async v2"}
      where id = ${asynchronous.id}
    `;
    const asyncQueue = await indexSql<{ readonly content_version: number }[]>`
      select content_version
      from ${queue}
      where record_id = ${asynchronous.id}
      order by content_version
    `;
    assert.deepEqual(Array.from(asyncQueue), [
      { content_version: 1 },
      { content_version: 2 },
    ]);
  } finally {
    await indexSql?.end();
    await dropTestDatabase(admin, database);
    await admin.end();
  }
});
