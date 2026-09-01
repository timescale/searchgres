import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = "packages/filter/grammar/filter.ebnf";
const target = "docs/reference/filter-syntax.html";
const check = process.argv.includes("--check");
const output = check
  ? join(tmpdir(), `searchgres-filter-syntax-${process.pid}.html`)
  : target;

try {
  const processResult = Bun.spawn(
    [
      "./bun",
      "x",
      "ebnf2railroad",
      "--quiet",
      "--lint",
      "--title",
      "Searchgres Filter Expression Syntax",
      source,
      "--target",
      output,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await processResult.exited;
  if (exitCode !== 0) process.exit(exitCode);

  // ebnf2railroad embeds the current minute in otherwise deterministic output.
  // Normalize it so regeneration checks do not become stale with the clock.
  const generated = await readFile(output, "utf8");
  const normalized = generated
    .replace(/<p>Date: [^<]+ - <a/, "<p>Date: generated - <a")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  await writeFile(output, normalized);

  if (check) {
    const [actual, expected] = await Promise.all([
      readFile(output),
      readFile(target),
    ]);
    if (!actual.equals(expected)) {
      throw new Error(
        `generated ${target} is stale; run ./bun run generate:filter-grammar`,
      );
    }
  }
} finally {
  if (check) await rm(output, { force: true });
}
