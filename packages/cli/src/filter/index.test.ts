import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FilterExpressionError,
  MAX_FILTER_NODES,
  MAX_FILTER_SOURCE_BYTES,
  parseFilter,
} from "./index.ts";

describe("filter parser limits and diagnostics", () => {
  test("accepts exactly the maximum node count", () => {
    const leaves = Array.from(
      { length: MAX_FILTER_NODES - 1 },
      (_, index) => `(tree t${index})`,
    );
    assert.doesNotThrow(() => parseFilter(`(and ${leaves.join(" ")})`));
    assert.throws(
      () => parseFilter(`(and ${leaves.join(" ")} (tree overflow))`),
      (error: unknown) =>
        error instanceof FilterExpressionError &&
        error.reason === "too_many_nodes",
    );
  });

  test("counts the root as depth one", () => {
    let accepted = "(tree docs)";
    for (let index = 1; index < 16; index += 1) accepted = `(not ${accepted})`;
    assert.ok(parseFilter(accepted));
    assert.throws(
      () => parseFilter(`(not ${accepted})`),
      (error: unknown) =>
        error instanceof FilterExpressionError && error.reason === "too_deep",
    );
  });

  test("caps source by UTF-8 bytes", () => {
    assert.throws(
      () => parseFilter(`;${"😀".repeat(MAX_FILTER_SOURCE_BYTES / 2)}`),
      (error: unknown) =>
        error instanceof FilterExpressionError &&
        error.reason === "source_too_large",
    );
  });

  test("reports structured Unicode-aware locations", () => {
    assert.throws(
      () =>
        parseFilter("; first line\r\n(and (tree docs) 😀)", {
          sourceName: "x.filter",
        }),
      (error: unknown) => {
        assert.ok(error instanceof FilterExpressionError);
        assert.equal(error.sourceName, "x.filter");
        assert.equal(error.reason, "syntax");
        assert.equal(error.line, 2);
        assert.equal(error.column, 18);
        assert.match(error.message, /^x\.filter:2:18:/);
        return true;
      },
    );
  });

  test("bounds the source excerpt included in errors", () => {
    assert.throws(
      () => parseFilter("x".repeat(10_000)),
      (error: unknown) => {
        assert.ok(error instanceof FilterExpressionError);
        assert.ok(error.sourceLine.length <= 161);
        assert.ok(error.message.length < 300);
        return true;
      },
    );
  });
});
