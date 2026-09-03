import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { test } from "node:test";

function markdownFiles(path: string): readonly string[] {
  if (extname(path) === ".md") return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && extname(child) === ".md" ? [child] : [];
  });
}

const files = [
  "README.md",
  ...markdownFiles("docs"),
  ...markdownFiles("examples"),
];

const markdownLink = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

test("discovers nested public Markdown", () => {
  assert.ok(files.includes("docs/concepts/how-search-works.md"));
  assert.ok(files.includes("examples/basic-search/README.md"));
});

test("relative links in public Markdown resolve", () => {
  const broken: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(markdownLink)) {
      const destination = match[1];
      if (
        !destination ||
        destination.startsWith("#") ||
        /^[a-z][a-z+.-]*:/i.test(destination)
      ) {
        continue;
      }
      const path = destination.split("#", 1)[0];
      if (path && !existsSync(resolve(dirname(file), path))) {
        broken.push(`${file} -> ${destination}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});
