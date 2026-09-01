import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILTER_SOURCE_BYTES } from "@searchgres/filter";
import {
  filterExpressionFromFlags,
  readBoundedFilterSource,
} from "./filter-input.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("resolves and parses an inline filter expression", async () => {
  expect(
    await filterExpressionFromFlags(
      new Map([["filter", "(or (tree docs) (tree guides))"]]),
    ),
  ).toEqual({ or: [{ tree: "docs" }, { tree: "guides" }] });
});

test("reads a strict UTF-8 filter file and strips one BOM", async () => {
  const directory = await temporaryDirectory();
  const path = join(directory, "filter.sgfilter");
  await writeFile(path, Buffer.from("efbbbf287472656520646f637329", "hex"));
  expect(await readBoundedFilterSource(path)).toBe("(tree docs)");
  expect(
    await filterExpressionFromFlags(new Map([["filter-file", path]])),
  ).toEqual({ tree: "docs" });
});

test("rejects invalid UTF-8, repeated BOMs, and oversized filter files", async () => {
  const directory = await temporaryDirectory();
  const repeatedBom = join(directory, "repeated-bom.sgfilter");
  await writeFile(
    repeatedBom,
    Buffer.from("efbbbfefbbbf287472656520646f637329", "hex"),
  );
  await expect(readBoundedFilterSource(repeatedBom)).rejects.toThrow(
    /more than one UTF-8 BOM/,
  );

  const invalid = join(directory, "invalid.sgfilter");
  await writeFile(invalid, new Uint8Array([0xc3, 0x28]));
  await expect(readBoundedFilterSource(invalid)).rejects.toThrow(
    /not valid UTF-8/,
  );

  const oversized = join(directory, "oversized.sgfilter");
  await writeFile(oversized, "x".repeat(MAX_FILTER_SOURCE_BYTES + 4));
  await expect(readBoundedFilterSource(oversized)).rejects.toThrow(
    /exceeds 1048576 UTF-8 bytes/,
  );
});

test("rejects both expression source flags before parsing", async () => {
  await expect(
    filterExpressionFromFlags(
      new Map([
        ["filter", "(tree docs)"],
        ["filter-file", "unused.sgfilter"],
      ]),
    ),
  ).rejects.toThrow(/cannot be combined/);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "searchgres-filter-"));
  directories.push(directory);
  return directory;
}
