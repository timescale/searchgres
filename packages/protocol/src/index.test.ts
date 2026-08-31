import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  methods,
  searchParamsSchema,
  upsertManyParamsSchema,
} from "./index.ts";

test("server wire records reject user-supplied embeddings", () => {
  const result = upsertManyParamsSchema.safeParse({
    records: [{ content: "hello", embedding: [1, 2, 3] }],
  });
  assert.equal(result.success, false);
});

test("search wire schema retains core hybrid and paging constraints", () => {
  assert.equal(
    searchParamsSchema.safeParse({
      semantic: "hello",
      after: "019ce89d-f8b4-7000-8000-000000000001",
    }).success,
    false,
  );
  assert.equal(
    searchParamsSchema.safeParse({
      fulltext: "hello",
      candidateLimit: 10,
    }).success,
    false,
  );
});

test("method registry exposes only the vertical slice", () => {
  assert.deepEqual(Object.keys(methods), [
    "rpc.discover",
    "searchgres.v1.server.info",
    "searchgres.v1.record.upsertMany",
    "searchgres.v1.search",
  ]);
  assert.equal(
    methods["searchgres.v1.search"].params instanceof z.ZodType,
    true,
  );
});
