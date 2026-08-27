import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { ExtensionError } from "../src/errors.ts";
import {
  connect,
  connectToDatabase,
  createTestDatabase,
  dropTestDatabase,
  randomTestDatabase,
} from "./support/db.ts";

test("createIndex requires extensions installed in public", async () => {
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

    await assert.rejects(
      () => createIndex(indexSql as Sql, indexSchema, { dimensions: 4 }),
      (error: unknown) => {
        assert.ok(error instanceof ExtensionError);
        assert.equal(error.reason, "wrong_schema");
        assert.equal(error.extension, "vector");
        return true;
      },
    );

    // The failed transaction must not leave the index schema behind.
    const [present] = await indexSql<{ readonly present: boolean }[]>`
      select exists (
        select 1 from pg_catalog.pg_namespace where nspname = ${indexSchema}
      ) as present
    `;
    assert.equal(present?.present, false);
  } finally {
    await indexSql?.end();
    await dropTestDatabase(admin, database);
    await admin.end();
  }
});
