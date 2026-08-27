import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boundedError,
  isRateLimitError,
  MAX_ERROR_LENGTH,
  resolveBatchSize,
} from "../src/embedding.ts";
import { RateLimitError } from "../src/errors.ts";
import type { Index } from "../src/open-index.ts";

function indexWithModel(embedding: unknown): Index {
  return { embedding } as unknown as Index;
}

test("resolveBatchSize clamps a request to the model's max-per-call", async () => {
  const index = indexWithModel({ maxEmbeddingsPerCall: 5 });
  assert.equal(await resolveBatchSize(index, 100), 5);
  assert.equal(await resolveBatchSize(index, 3), 3);
  assert.equal(await resolveBatchSize(index, undefined), 5);
});

test("resolveBatchSize falls back to a default without a finite model limit", async () => {
  const stringModel = indexWithModel("some-model-id");
  assert.equal(await resolveBatchSize(stringModel, undefined), 10);
  assert.equal(await resolveBatchSize(stringModel, 7), 7);

  const infinite = indexWithModel({
    maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
  });
  assert.equal(await resolveBatchSize(infinite, undefined), 10);
});

test("resolveBatchSize awaits a promised max-per-call", async () => {
  const index = indexWithModel({ maxEmbeddingsPerCall: Promise.resolve(4) });
  assert.equal(await resolveBatchSize(index, 100), 4);
});

test("isRateLimitError detects direct and wrapped 429s", () => {
  assert.equal(isRateLimitError(new RateLimitError()), true);
  assert.equal(isRateLimitError({ statusCode: 429 }), true);
  assert.equal(isRateLimitError({ lastError: { statusCode: 429 } }), true);
  assert.equal(isRateLimitError({ errors: [{ statusCode: 429 }] }), true);
  assert.equal(isRateLimitError({ statusCode: 500 }), false);
  assert.equal(isRateLimitError(new Error("nope")), false);
});

test("boundedError truncates a verbose provider message", () => {
  const short = boundedError(new Error("boom"));
  assert.equal(short, "boom");
  const long = boundedError(new Error("x".repeat(MAX_ERROR_LENGTH + 500)));
  assert.equal(long.length, MAX_ERROR_LENGTH);
});
