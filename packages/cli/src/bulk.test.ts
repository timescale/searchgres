import { expect, test } from "bun:test";
import { chunkRecordsForRequest } from "./bulk.ts";

test("import chunks at the protocol's 1000-record cap", () => {
  const records = Array.from({ length: 1001 }, (_, index) => ({
    content: `record ${index}`,
  }));
  expect(
    chunkRecordsForRequest(records, Number.MAX_SAFE_INTEGER, "error").map(
      (batch) => batch.length,
    ),
  ).toEqual([1000, 1]);
});

test("import also chunks on its request byte budget", () => {
  const records = [
    { content: "a".repeat(400) },
    { content: "b".repeat(400) },
    { content: "c".repeat(400) },
  ];
  const batches = chunkRecordsForRequest(records, 700, "replace");
  expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
});

test("an individually oversized record is isolated", () => {
  const records = [
    { content: "small" },
    { content: "x".repeat(2_000) },
    { content: "small again" },
  ];
  const batches = chunkRecordsForRequest(records, 500, "error");
  expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
  expect(batches[1]?.[0]?.content).toHaveLength(2_000);
});
