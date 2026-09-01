import { expect, test } from "bun:test";
import type { SearchResult } from "@searchgres/protocol";
import {
  parseSelectFields,
  projectSearchEnvelope,
  projectSearchResult,
} from "./selection.ts";

const result: SearchResult = {
  id: "01900000-0000-7000-8000-000000000001",
  content: "A😀BCDéF",
  meta: {
    source: "docs",
    private: true,
    "build.id": 42,
    $thread: "thread-1",
  },
  tree: "docs.search",
  name: null,
  temporal: null,
  score: -1,
  hasEmbedding: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
  version: "2",
  versionHash: "abc123",
};

test("bare selectors project every Searchgres result field", () => {
  const selected = parseSelectFields(
    "id,content,meta,tree,name,temporal,score,hasEmbedding,createdAt,updatedAt,version,versionHash",
  );
  expect(projectSearchResult(result, selected)).toEqual(result);
});

test("content shorthand counts Unicode code points and reports full length", () => {
  expect(
    projectSearchResult(result, parseSelectFields("id,content:2")),
  ).toEqual({
    id: result.id,
    content: "A😀",
    contentLength: 8,
  });
});

test("content ranges support bounded, open, and negative offsets", () => {
  const cases = [
    ["content:2..5", "BCD"],
    ["content:5..", "éF"],
    ["content:..3", "A😀B"],
    ["content:-2..", "́F"],
    ["content:..-2", "A😀BCDe"],
    ["content:-5..-2", "CDe"],
  ] as const;
  for (const [selector, content] of cases) {
    expect(projectSearchResult(result, parseSelectFields(selector))).toEqual({
      content,
      contentLength: 8,
    });
  }
});

test("equivalent content shorthand and range may be repeated", () => {
  expect(
    projectSearchResult(
      result,
      parseSelectFields("content:3,content:..3,content:3"),
    ),
  ).toEqual({ content: "A😀B", contentLength: 8 });
});

test("metadata selectors use exact top-level keys and omit missing keys", () => {
  expect(
    projectSearchResult(
      result,
      parseSelectFields("meta.$thread,meta.build.id,meta.missing"),
    ),
  ).toEqual({ meta: { $thread: "thread-1", "build.id": 42 } });
});

test("selecting full metadata wins over individual metadata keys", () => {
  expect(
    projectSearchResult(result, parseSelectFields("meta.source,meta")),
  ).toEqual({ meta: result.meta });
});

test("special metadata names remain data properties", () => {
  const special = {
    ...result,
    meta: JSON.parse('{"__proto__":"safe"}') as SearchResult["meta"],
  };
  const projected = projectSearchResult(
    special,
    parseSelectFields("meta.__proto__"),
  );
  expect(JSON.stringify(projected)).toBe('{"meta":{"__proto__":"safe"}}');
});

test("projection preserves the search envelope and null and sentinel values", () => {
  expect(
    projectSearchEnvelope(
      { results: [result] },
      parseSelectFields("name,temporal,score,updatedAt"),
    ),
  ).toEqual({
    results: [{ name: null, temporal: null, score: -1, updatedAt: null }],
  });
});

test("invalid selectors are rejected", () => {
  for (const selector of [
    "",
    "id,",
    "unknown",
    "createdBy",
    "meta.",
    "content:",
    "content:..",
    "content:-1",
    "content:abc",
    "content:20...40",
    "content:1.5..10",
    "content:10..abc",
  ]) {
    expect(() => parseSelectFields(selector), selector).toThrow();
  }
});

test("more than one distinct content selection is rejected", () => {
  expect(() => parseSelectFields("content,content:20")).toThrow(
    /only one distinct content selection/,
  );
  expect(() => parseSelectFields("content:10,content:-10..")).toThrow(
    /only one distinct content selection/,
  );
});
