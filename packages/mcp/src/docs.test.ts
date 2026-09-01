import { expect, test } from "bun:test";
import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MCP_DOCS_BASE, TOOL_NAMES } from "./server.ts";

const docs = fileURLToPath(new URL("../../../docs/mcp", import.meta.url));

test("every MCP tool has exactly one linked documentation page", async () => {
  const files = (await readdir(docs))
    .filter((file) => file.startsWith("searchgres_") && file.endsWith(".md"))
    .toSorted();
  expect(files).toEqual(TOOL_NAMES.map((name) => `${name}.md`).toSorted());
  for (const name of TOOL_NAMES) {
    await access(`${docs}/${name}.md`);
    expect(`${MCP_DOCS_BASE}/${name}.md`).toContain(`/docs/mcp/${name}.md`);
  }
});
