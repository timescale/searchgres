import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { test } from "node:test";

function markdownFiles(path: string): readonly string[] {
  if (extname(path) === ".md") return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? markdownFiles(child) : [];
  });
}

const files = [
  "README.md",
  ...markdownFiles("docs"),
  ...markdownFiles("examples"),
];

const markdownLink = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

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
