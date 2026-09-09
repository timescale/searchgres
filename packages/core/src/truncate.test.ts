import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidConfigError } from "./errors.ts";
import {
  truncateBytes,
  truncateCharacters,
  truncateTokens,
} from "./truncate.ts";

test("truncators reject non-positive limits with InvalidConfigError", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => truncateCharacters(bad),
      (error: unknown) =>
        error instanceof InvalidConfigError &&
        error.issues[0]?.path[0] === "maxChars",
    );
    assert.throws(() => truncateBytes(bad), InvalidConfigError);
    assert.throws(
      () =>
        truncateTokens({
          maxTokens: bad,
          encode: (text) => [...text].map((_, i) => i),
          decode: (tokens) => tokens.map(() => "x").join(""),
        }),
      InvalidConfigError,
    );
  }
});

test("truncateCharacters keeps code points intact", async () => {
  const truncate = truncateCharacters(3);
  assert.equal(await truncate("abcdef"), "abc");
  // "😀" is a surrogate pair; cutting mid-pair must round down
  assert.equal(await truncate("ab😀"), "ab");
});
