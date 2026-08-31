import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  createOpenRpcDocument,
  methods,
  patchParamsSchema,
  searchParamsSchema,
  upsertManyParamsSchema,
} from "./index.ts";

test("server wire records reject user-supplied embeddings", () => {
  const result = upsertManyParamsSchema.safeParse({
    records: [{ content: "hello", embedding: [1, 2, 3] }],
  });
  assert.equal(result.success, false);
});

test("record patches reject a user-supplied embedding", () => {
  assert.equal(
    patchParamsSchema.safeParse({
      id: "019ce89d-f8b4-7000-8000-000000000001",
      priorVersionHash: "prior",
      patch: { embedding: [1, 2, 3] },
    }).success,
    false,
  );
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

test("generated OpenRPC document describes the vertical slice", () => {
  const document = createOpenRpcDocument();
  assert.equal(document.openrpc, "1.3.2");
  assert.deepEqual(
    document.methods.map((method) => method.name),
    [
      "rpc.discover",
      "searchgres.v1.server.info",
      "searchgres.v1.record.upsert",
      "searchgres.v1.record.upsertMany",
      "searchgres.v1.record.insert",
      "searchgres.v1.record.insertMany",
      "searchgres.v1.record.get",
      "searchgres.v1.record.getByName",
      "searchgres.v1.record.patch",
      "searchgres.v1.record.delete",
      "searchgres.v1.record.deleteByName",
      "searchgres.v1.search",
    ],
  );
  const search = document.methods.find(
    (method) => method.name === "searchgres.v1.search",
  );
  assert.equal(
    (search?.params?.[0]?.schema as { readonly type?: unknown } | undefined)
      ?.type,
    "object",
  );
  assert.equal(search?.result.name, "result");
  assert.equal(
    methods["searchgres.v1.search"].params instanceof z.ZodType,
    true,
  );
});
