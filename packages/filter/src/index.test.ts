import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  FilterExpressionError,
  MAX_FILTER_NODES,
  MAX_FILTER_SOURCE_BYTES,
  parseFilter,
} from "./index.ts";

describe("parseFilter", () => {
  test("compiles all predicates and boolean operators", () => {
    assert.deepEqual(
      parseFilter(`
        (and
          (tree docs.api)
          (lquery "docs.*{1,3}")
          (ltxtquery "postgres & search")
          (meta {"status":"published","nested":{"ok":true}})
          (meta-predicate "$.status == \\"published\\"")
          (temporal-within 2025-01-01T00:00:00Z 2026-01-01T00:00:00Z)
          (temporal-overlaps 2024-01-01T00:00:00Z 2025-01-01T00:00:00Z)
          (temporal-before 2027-01-01T00:00:00Z)
          (temporal-after 2020-01-01T00:00:00Z)
          (temporal-contains 2025-06-01T00:00:00Z)
          (regexp "postgres|search")
          (or (tree guides) (not (meta {"archived":true}))))
      `),
      {
        and: [
          { tree: "docs.api" },
          { lquery: "docs.*{1,3}" },
          { ltxtquery: "postgres & search" },
          { meta: { status: "published", nested: { ok: true } } },
          { metaPredicate: '$.status == "published"' },
          {
            temporalWithin: ["2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
          },
          {
            temporalOverlaps: ["2024-01-01T00:00:00Z", "2025-01-01T00:00:00Z"],
          },
          { temporalBefore: "2027-01-01T00:00:00Z" },
          { temporalAfter: "2020-01-01T00:00:00Z" },
          { temporalContains: "2025-06-01T00:00:00Z" },
          { regexp: "postgres|search" },
          {
            or: [{ tree: "guides" }, { not: { meta: { archived: true } } }],
          },
        ],
      },
    );
  });

  test("supports JSON strings, empty root trees, comments, CRLF, and a BOM", () => {
    assert.deepEqual(
      parseFilter(
        '\uFEFF; heading\r\n(and (tree "") ; inline\r\n(regexp "error; \\ud83d\\ude00"))',
      ),
      {
        and: [{ tree: "" }, { regexp: "error; 😀" }],
      },
    );
  });

  test("preserves explicit nesting and child order", () => {
    assert.deepEqual(parseFilter("(and (tree a) (and (tree b) (tree c)))"), {
      and: [{ tree: "a" }, { and: [{ tree: "b" }, { tree: "c" }] }],
    });
  });

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

  test("rejects malformed syntax, arity, JSON, and protocol values", () => {
    const invalid = [
      "",
      "tree docs",
      "(AND (tree a) (tree b))",
      "(and (tree a))",
      "(or (tree a))",
      "(not)",
      "(not (tree a) (tree b))",
      "(tree)",
      "(tree a b)",
      "(meta {})",
      "(meta [])",
      '(meta {"a":1,})',
      '(regexp "")',
      "(tree docs/slash)",
      "(temporal-after yesterday)",
      "(temporal-within 2026-01-01T00:00:00Z 2025-01-01T00:00:00Z)",
      "(tree a) (tree b)",
      "(tree a",
    ];
    for (const source of invalid) {
      assert.throws(() => parseFilter(source), FilterExpressionError, source);
    }
  });
});
