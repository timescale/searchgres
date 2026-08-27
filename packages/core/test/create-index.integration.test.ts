import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex, SCHEMA_FORMAT_VERSION } from "../src/create-index.ts";
import {
  ConflictError,
  InvalidConfigError,
  InvalidIndexError,
  SchemaVersionError,
} from "../src/errors.ts";
import { openIndex } from "../src/open-index.ts";
import { expectSqlState } from "./support/assert.ts";
import {
  columnType,
  connect,
  dropTestSchema,
  indexOpclass,
  indexReloptions,
  listFunctions,
  listIndexes,
  listTriggers,
  randomTestSchema,
  schemaExists,
} from "./support/db.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

test("creates an immutable index schema and singleton format marker", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });

    assert.equal(await schemaExists(sql, schema), true);
    const version = sql`${sql(schema)}.version`;
    const versions = await sql<
      { readonly version: string; readonly at: Date }[]
    >`
      select version, at
      from ${version}
    `;
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.version, SCHEMA_FORMAT_VERSION);
    assert.ok(versions[0]?.at instanceof Date);
    await expectSqlState(
      () => sql`insert into ${version} (version) values ('another')`,
      "23505",
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects an existing schema without mutating it", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    await assert.rejects(
      () => createIndex(sql, schema, { dimensions: 4 }),
      ConflictError,
    );
    assert.equal(await schemaExists(sql, schema), true);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("opens an immutable index with catalog-derived vector shape", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: "mock-embedding" });

    assert.equal(index.schema, schema);
    assert.equal(index.vectorType, "halfvec");
    assert.equal(index.dimensions, 4);
    assert.equal(index.embedding, "mock-embedding");
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects plain schemas and unsupported schema formats", async () => {
  const plainSchema = randomTestSchema();
  const versionedSchema = randomTestSchema();
  try {
    await sql`create schema ${sql(plainSchema)}`;
    await assert.rejects(
      () => openIndex(sql, plainSchema, { embedding: "mock-embedding" }),
      InvalidIndexError,
    );

    await createIndex(sql, versionedSchema, { dimensions: 4 });
    await sql`
      update ${sql(versionedSchema)}.version
      set version = '2'
    `;
    await assert.rejects(
      () => openIndex(sql, versionedSchema, { embedding: "mock-embedding" }),
      SchemaVersionError,
    );
  } finally {
    await dropTestSchema(sql, plainSchema);
    await dropTestSchema(sql, versionedSchema);
  }
});

test("creates the configured schema shape and search indexes", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, {
      dimensions: 4,
      bm25: { k1: 1.5, b: 0.5 },
      hnsw: { m: 8, efConstruction: 32 },
    });

    assert.equal(
      await columnType(sql, schema, "record", "embedding"),
      "halfvec(4)",
    );
    assert.equal(await columnType(sql, schema, "record", "tree"), "ltree");
    assert.equal(
      await columnType(sql, schema, "embedding_queue", "record_id"),
      "uuid",
    );
    assert.deepEqual(await listTriggers(sql, schema, "record"), [
      "record_enqueue_after_content_update",
      "record_enqueue_after_insert",
      "record_integrity_before_write",
    ]);
    assert.ok(
      (await listFunctions(sql, schema)).includes("batch_upsert"),
      "missing batch_upsert routine",
    );

    const indexes = await listIndexes(sql, schema, "record");
    for (const index of [
      "record_meta_gin_idx",
      "record_temporal_gist_idx",
      "record_content_bm25_idx",
      "record_embedding_hnsw_idx",
      "record_tree_gist_idx",
      "record_tree_name_uidx",
    ]) {
      assert.ok(indexes.includes(index), `missing index ${index}`);
    }
    assert.equal(
      await indexOpclass(sql, schema, "record_embedding_hnsw_idx"),
      "halfvec_cosine_ops",
    );
    assert.deepEqual(
      await indexReloptions(sql, schema, "record_embedding_hnsw_idx"),
      ["m=8", "ef_construction=32"],
    );
    assert.deepEqual(
      await indexReloptions(sql, schema, "record_content_bm25_idx"),
      ["text_config=english", "k1=1.5", "b=0.5"],
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("direct SQL supports precomputed and asynchronous embeddings", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const embeddingType = sql`public.${sql("halfvec")}`;
    const record = sql`${sql(schema)}.record`;
    const queue = sql`${sql(schema)}.embedding_queue`;

    const [precomputed] = await sql<
      {
        readonly id: string;
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      insert into ${record}
        (content, embedding, content_version, version)
      values
        ('precomputed v1', ${"[1,0,0,0]"}::${embeddingType}, 99, 99)
      returning id, embedding, content_version, version, version_hash
    `;
    assert.ok(precomputed);
    assert.equal(precomputed.embedding, "[1,0,0,0]");
    assert.equal(precomputed.content_version, 1);
    assert.equal(precomputed.version, "1");
    assert.match(precomputed.version_hash, /^[a-f0-9]{32}$/);

    const [precomputedUpdated] = await sql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set content = 'precomputed v2',
          embedding = ${"[0,1,0,0]"}::${embeddingType},
          content_version = 999,
          version = 999
      where id = ${precomputed.id}
      returning embedding, content_version, version, version_hash
    `;
    assert.ok(precomputedUpdated);
    assert.equal(precomputedUpdated.embedding, "[0,1,0,0]");
    assert.equal(precomputedUpdated.content_version, 2);
    assert.equal(precomputedUpdated.version, "2");
    assert.notEqual(precomputedUpdated.version_hash, precomputed.version_hash);

    const precomputedQueue = await sql`
      select id
      from ${queue}
      where record_id = ${precomputed.id}
    `;
    assert.deepEqual(Array.from(precomputedQueue), []);

    const [asynchronous] = await sql<
      {
        readonly id: string;
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      insert into ${record} (content)
      values ('async v1')
      returning id, embedding, content_version, version, version_hash
    `;
    assert.ok(asynchronous);
    assert.equal(asynchronous.embedding, null);
    assert.equal(asynchronous.content_version, 1);
    assert.equal(asynchronous.version, "1");

    const [metadataUpdated] = await sql<
      {
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set content = 'async v2'
      where id = ${asynchronous.id}
      returning content_version, version, version_hash
    `;
    assert.ok(metadataUpdated);
    assert.equal(metadataUpdated.content_version, 2);
    assert.equal(metadataUpdated.version, "2");
    assert.notEqual(metadataUpdated.version_hash, asynchronous.version_hash);

    const [metaOnlyUpdated] = await sql<
      {
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set meta = ${sql.json({ source: "direct" })}
      where id = ${asynchronous.id}
      returning content_version, version, version_hash
    `;
    assert.ok(metaOnlyUpdated);
    assert.equal(metaOnlyUpdated.content_version, 2);
    assert.equal(metaOnlyUpdated.version, "3");
    assert.notEqual(metaOnlyUpdated.version_hash, metadataUpdated.version_hash);

    const queueRows = await sql<
      {
        readonly content_version: number;
        readonly outcome: string | null;
      }[]
    >`
      select content_version, outcome
      from ${queue}
      where record_id = ${asynchronous.id}
      order by content_version
    `;
    assert.deepEqual(Array.from(queueRows), [
      { content_version: 1, outcome: null },
      { content_version: 2, outcome: null },
    ]);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rolls back provisioning when BM25 text configuration is invalid", async () => {
  const schema = randomTestSchema();
  try {
    await assert.rejects(
      () =>
        createIndex(sql, schema, {
          dimensions: 4,
          bm25: { textConfig: "searchgres_unknown_text_config" },
        }),
      InvalidConfigError,
    );
    assert.equal(await schemaExists(sql, schema), false);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
