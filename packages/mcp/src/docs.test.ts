import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MCP_DOCS_URL, TOOL_NAMES } from "./server.ts";

const docs = fileURLToPath(new URL("../../../docs/mcp", import.meta.url));

test("the compact MCP guide describes every discovered tool", async () => {
  const files = await readdir(docs);
  expect(
    files.filter(
      (file) => file.startsWith("searchgres_") && file.endsWith(".md"),
    ),
  ).toEqual([]);

  const guide = await readFile(`${docs}/index.md`, "utf8");
  for (const name of TOOL_NAMES) expect(guide).toContain(`\`${name}\``);
  expect(MCP_DOCS_URL).toEndWith("/docs/mcp/index.md#tools");
});
