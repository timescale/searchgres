import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { MigrationError, SchemaVersionError } from "../src/errors.ts";
import { bootstrapIndex, schemaExists } from "../src/migrate/bootstrap.ts";
import {
  type RunMigrationsOptions,
  readAppliedMigrations,
  runMigrations,
} from "../src/migrate/runner.ts";
import type { Migration } from "../src/migrate/types.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";

let sql: Sql;

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
