import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import {
  type NormalizedIndexConfig,
  normalizeIndexConfig,
} from "../src/config.ts";
import { type ExtensionInfo, ensureExtension } from "../src/db/extensions.ts";
import {
  InvalidConfigError,
  MigrationError,
  SchemaVersionError,
} from "../src/errors.ts";
import { bootstrapIndex, schemaExists } from "../src/migrate/bootstrap.ts";
import { INITIAL_MIGRATIONS } from "../src/migrate/initial.ts";
import {
  type RunMigrationsOptions,
  readAppliedMigrations,
  runMigrations,
} from "../src/migrate/runner.ts";
import type { Migration } from "../src/migrate/types.ts";
import {
  columnType,
  connect,
  dropTestSchema,
  indexOpclass,
  indexReloptions,
  listIndexes,
  listTriggers,
  randomTestSchema,
} from "./support/db.ts";

let sql: Sql;

const initialExtensions = [
  { name: "vector", minimumVersion: "0.8.0" },
  { name: "pg_textsearch", minimumVersion: "1.4.0" },
  { name: "ltree", minimumVersion: "1.3.0" },
] as const;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

test("bootstraps an untracked schema and migration ledger", async () => {
  const schema = randomTestSchema();
  try {
    await sql.begin((tx) => bootstrapIndex(tx, schema));

    assert.equal(await schemaExists(sql, schema), true);
    const migrations = await sql.begin((tx) =>
      readAppliedMigrations(tx, schema),
    );
    assert.deepEqual(migrations, []);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("applies the initial record, index, queue, and trigger migrations", async () => {
  const schema = randomTestSchema();
  try {
    const { applied } = await provisionInitialIndex(schema);

    assert.deepEqual(applied, [
      "001_record_table",
      "002_indexes",
      "003_embedding_queue",
      "004_integrity_triggers",
    ]);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("creates the configured schema shape and search indexes", async () => {
  const schema = randomTestSchema();
  try {
    await provisionInitialIndex(
      schema,
      normalizeIndexConfig({
        dimensions: 4,
        bm25: { k1: 1.5, b: 0.5 },
        hnsw: { m: 8, efConstruction: 32 },
      }),
    );

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

test("direct SQL writes cannot bypass the asynchronous embedding queue", async () => {
  const schema = randomTestSchema();
  try {
    const { extensions } = await provisionInitialIndex(schema);
    const vector = extensions.find((extension) => extension.name === "vector");
    assert.ok(vector);
    const embeddingType = sql`${sql(vector.schema)}.${sql("halfvec")}`;
    const record = sql`${sql(schema)}.record`;
    const queue = sql`${sql(schema)}.embedding_queue`;

    const [inserted] = await sql<
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
        ('direct v1', ${"[1,0,0,0]"}::${embeddingType}, 99, 99)
      returning id, embedding, content_version, version, version_hash
    `;
    assert.ok(inserted);
    assert.equal(inserted.embedding, null);
    assert.equal(inserted.content_version, 1);
    assert.equal(inserted.version, "1");
    assert.match(inserted.version_hash, /^[a-f0-9]{32}$/);

    const [updated] = await sql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set content = 'direct v2',
          embedding = ${"[0,1,0,0]"}::${embeddingType},
          content_version = 999,
          version = 999
      where id = ${inserted.id}
      returning embedding, content_version, version, version_hash
    `;
    assert.ok(updated);
    assert.equal(updated.embedding, null);
    assert.equal(updated.content_version, 2);
    assert.equal(updated.version, "2");
    assert.notEqual(updated.version_hash, inserted.version_hash);

    const [metadataUpdated] = await sql<
      {
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set meta = ${sql.json({ source: "direct" })}
      where id = ${inserted.id}
      returning content_version, version, version_hash
    `;
    assert.ok(metadataUpdated);
    assert.equal(metadataUpdated.content_version, 2);
    assert.equal(metadataUpdated.version, "3");
    assert.notEqual(metadataUpdated.version_hash, updated.version_hash);

    const queueRows = await sql<
      {
        readonly content_version: number;
        readonly outcome: string | null;
      }[]
    >`
      select content_version, outcome
      from ${queue}
      where record_id = ${inserted.id}
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

test("rejects an unknown BM25 text configuration as invalid config", async () => {
  const schema = randomTestSchema();
  try {
    await assert.rejects(
      () =>
        provisionInitialIndex(
          schema,
          normalizeIndexConfig({
            dimensions: 4,
            bm25: { textConfig: "searchgres_unknown_text_config" },
          }),
        ),
      InvalidConfigError,
    );
    assert.equal(await schemaExists(sql, schema), false);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rolls back bootstrap and migration work with the caller transaction", async () => {
  const schema = randomTestSchema();
  try {
    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          await bootstrapIndex(tx, schema);
          await runMigrations(
            tx,
            options(schema, [
              {
                name: "001_fails",
                minLibraryVersion: "1.0.0",
                up: async () => {
                  throw new Error("migration failure");
                },
              },
            ]),
          );
        }),
      MigrationError,
    );
    assert.equal(await schemaExists(sql, schema), false);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("applies pending migrations in name order exactly once", async () => {
  const schema = randomTestSchema();
  const calls: string[] = [];
  const migrations: readonly Migration[] = [
    {
      name: "002_second",
      minLibraryVersion: "1.2.0",
      up: async () => {
        calls.push("002_second");
      },
    },
    {
      name: "001_first",
      minLibraryVersion: "1.0.0",
      up: async () => {
        calls.push("001_first");
      },
    },
  ];
  try {
    const first = await sql.begin(async (tx) => {
      await bootstrapIndex(tx, schema);
      return runMigrations(tx, options(schema, migrations));
    });
    const second = await sql.begin((tx) =>
      runMigrations(tx, options(schema, migrations)),
    );
    const applied = await sql.begin((tx) => readAppliedMigrations(tx, schema));

    assert.deepEqual(calls, ["001_first", "002_second"]);
    assert.deepEqual(first.applied, ["001_first", "002_second"]);
    assert.equal(first.minimumLibraryVersion, "1.2.0");
    assert.deepEqual(second.applied, []);
    assert.deepEqual(
      applied.map((migration) => migration.name),
      ["001_first", "002_second"],
    );
    assert.deepEqual(
      applied.map((migration) => migration.appliedByVersion),
      ["1.2.3", "1.2.3"],
    );
    assert.deepEqual(
      applied.map((migration) => migration.minLibraryVersion),
      ["1.0.0", "1.2.0"],
    );
    assert.ok(
      applied.every((migration) => migration.appliedAt instanceof Date),
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects duplicate migration names before applying either migration", async () => {
  const schema = randomTestSchema();
  try {
    await sql.begin((tx) => bootstrapIndex(tx, schema));

    await assert.rejects(
      () =>
        sql.begin((tx) =>
          runMigrations(
            tx,
            options(schema, [
              {
                name: "001_duplicate",
                minLibraryVersion: "1.0.0",
                up: async () => {},
              },
              {
                name: "001_duplicate",
                minLibraryVersion: "1.0.0",
                up: async () => {},
              },
            ]),
          ),
        ),
      MigrationError,
    );

    const applied = await sql.begin((tx) => readAppliedMigrations(tx, schema));
    assert.deepEqual(applied, []);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects a library below the applied migration compatibility floor", async () => {
  const schema = randomTestSchema();
  try {
    await sql.begin(async (tx) => {
      await bootstrapIndex(tx, schema);
      await runMigrations(
        tx,
        options(
          schema,
          [
            {
              name: "001_floor",
              minLibraryVersion: "2.0.0",
              up: async () => {},
            },
          ],
          "2.0.0",
        ),
      );
    });

    await assert.rejects(
      () => sql.begin((tx) => runMigrations(tx, options(schema, [], "1.0.0"))),
      SchemaVersionError,
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

function options(
  schema: string,
  migrations: readonly Migration[],
  libraryVersion = "1.2.3",
): RunMigrationsOptions {
  return {
    schema,
    migrations,
    context: { creation: null, extensions: [] },
    libraryVersion,
  };
}

async function provisionInitialIndex(
  schema: string,
  creation: NormalizedIndexConfig = normalizeIndexConfig({ dimensions: 4 }),
): Promise<{
  readonly applied: readonly string[];
  readonly extensions: readonly ExtensionInfo[];
}> {
  return sql.begin(async (tx) => {
    const extensions: ExtensionInfo[] = [];
    for (const requirement of initialExtensions) {
      extensions.push(await ensureExtension(tx, requirement));
    }
    await bootstrapIndex(tx, schema);
    const result = await runMigrations(tx, {
      schema,
      migrations: INITIAL_MIGRATIONS,
      context: { creation, extensions },
    });
    return { applied: result.applied, extensions };
  });
}
