import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { parse } from "yaml";
import {
  FilterExpressionError,
  type FilterExpressionErrorReason,
  parseFilter,
} from "./index.ts";

interface ResultCase {
  readonly name: string;
  readonly expression: string;
  readonly result: Record<string, unknown>;
  readonly error?: never;
}

interface ErrorCase {
  readonly name: string;
  readonly expression: string;
  readonly result?: never;
  readonly error: {
    readonly reason: FilterExpressionErrorReason;
    readonly line: number;
    readonly column: number;
    readonly detail: string;
  };
}

type ConformanceCase = ResultCase | ErrorCase;

const fixtureUrl = new URL("../test/cases.yaml", import.meta.url);
const cases = await loadCases();

describe("filter DSL conformance cases", () => {
  for (const fixture of cases) {
    test(fixture.name, () => {
      if (fixture.error === undefined) {
        assert.deepEqual(
          parseFilter(fixture.expression, { sourceName: fixture.name }),
          fixture.result,
        );
        return;
      }

      let thrown: unknown;
      try {
        parseFilter(fixture.expression, { sourceName: fixture.name });
      } catch (error) {
        thrown = error;
      }
      assert.ok(
        thrown instanceof FilterExpressionError,
        "expected parser error",
      );
      assert.equal(thrown.reason, fixture.error.reason);
      assert.equal(thrown.line, fixture.error.line);
      assert.equal(thrown.column, fixture.error.column);
      assert.equal(thrown.detail, fixture.error.detail);
    });
  }
});

async function loadCases(): Promise<readonly ConformanceCase[]> {
  const document: unknown = parse(await readFile(fixtureUrl, "utf8"), {
    maxAliasCount: 0,
    uniqueKeys: true,
  });
  assert.ok(Array.isArray(document), "filter cases YAML must contain an array");

  const names = new Set<string>();
  return document.map((value, index) => {
    assert.ok(isRecord(value), `case ${index + 1} must be an object`);
    assert.deepEqual(
      Object.keys(value).toSorted(),
      Object.keys(value).includes("result")
        ? ["expression", "name", "result"]
        : ["error", "expression", "name"],
      `case ${index + 1} has unknown or missing properties`,
    );
    const name = value.name;
    const expression = value.expression;
    if (typeof name !== "string") {
      assert.fail(`case ${index + 1} needs a name`);
    }
    assert.ok(name.length > 0, `case ${index + 1} needs a nonempty name`);
    assert.equal(
      names.has(name),
      false,
      `filter case name must be unique: ${name}`,
    );
    names.add(name);
    if (typeof expression !== "string") {
      assert.fail(`${name} needs a string expression`);
    }

    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    assert.notEqual(
      hasResult,
      hasError,
      `${name} needs exactly result or error`,
    );
    if (hasResult) {
      assert.ok(isRecord(value.result), `${name} result must be an object`);
      return { name, expression, result: value.result };
    }

    assert.ok(isRecord(value.error), `${name} error must be an object`);
    assert.deepEqual(
      Object.keys(value.error).toSorted(),
      ["column", "detail", "line", "reason"],
      `${name} error has unknown or missing properties`,
    );
    const { reason, line, column, detail } = value.error;
    if (!isErrorReason(reason)) {
      assert.fail(`${name} has an invalid error reason`);
    }
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      assert.fail(`${name} error needs a positive integer line`);
    }
    if (typeof column !== "number" || !Number.isInteger(column) || column < 1) {
      assert.fail(`${name} error needs a positive integer column`);
    }
    if (typeof detail !== "string") assert.fail(`${name} error needs detail`);
    return { name, expression, error: { reason, line, column, detail } };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorReason(value: unknown): value is FilterExpressionErrorReason {
  return (
    typeof value === "string" &&
    [
      "syntax",
      "arity",
      "json",
      "validation",
      "source_too_large",
      "too_deep",
      "too_many_nodes",
    ].includes(value)
  );
}
