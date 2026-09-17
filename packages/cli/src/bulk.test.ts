import { expect, test } from "bun:test";
import { chunkRecords } from "./bulk.ts";

test("import chunks at core's 1000-record cap without HTTP byte budgets", () => {
  const records = Array.from({ length: 1001 }, (_, i) => ({
    content: `record ${i}`,
  }));
  expect(chunkRecords(records).map((batch) => batch.length)).toEqual([1000, 1]);
  expect(
    chunkRecords([{ content: "x".repeat(2000000) }, { content: "small" }]).map(
      (b) => b.length,
    ),
  ).toEqual([2]);
  expect(chunkRecords([])).toEqual([]);
});
