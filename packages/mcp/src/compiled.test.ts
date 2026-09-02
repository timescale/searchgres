import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READ_TOOL_NAMES, TOOL_NAMES } from "./server.ts";

test("compiled searchgres-mcp serves stdio and honors --read-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "searchgres-mcp-"));
  const binary = join(directory, "searchgres-mcp");
  const requests: Array<{ method: string; params?: unknown }> = [];
  const api = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const rpc = (await request.json()) as {
        id: string;
        method: string;
        params?: unknown;
      };
      requests.push({ method: rpc.method, params: rpc.params });
      return Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          results: [
            {
              id: "01900000-0000-7000-8000-000000000001",
              content: "compiled 😀 result",
              meta: {},
              tree: "docs",
              name: null,
              temporal: null,
              hasEmbedding: true,
              version: "1",
              versionHash: "hash",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: null,
              score: 0.8,
            },
          ],
        },
      });
    },
  });
  try {
    const compiled = Bun.spawnSync({
      cmd: [
        "../../bun",
        "build",
        "./src/bin.ts",
        "--compile",
        `--outfile=${binary}`,
      ],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(compiled.exitCode).toBe(0);

    for (const readOnly of [false, true]) {
      const transport = new StdioClientTransport({
        command: binary,
        args: [
          "--server",
          api.url.toString().replace(/\/$/, ""),
          ...(readOnly ? ["--read-only"] : []),
        ],
        stderr: "pipe",
      });
      const client = new Client({ name: "compiled-test", version: "1" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toEqual([
          ...(readOnly ? READ_TOOL_NAMES : TOOL_NAMES),
        ]);
        const result = await client.callTool({
          name: "searchgres_search",
          arguments: { fulltext: "compiled", select: ["id", "content:8"] },
        });
        const content = (
          result.content as Array<{ type: string; text?: string }> | undefined
        )?.[0];
        if (content?.type !== "text" || content.text === undefined) {
          throw new Error("missing MCP text");
        }
        expect(JSON.parse(content.text)).toEqual({
          results: [
            {
              id: "01900000-0000-7000-8000-000000000001",
              content: "compiled",
              contentLength: 17,
            },
          ],
        });
      } finally {
        await client.close();
      }
    }
    expect(requests).toEqual([
      { method: "searchgres.v1.search", params: { fulltext: "compiled" } },
      { method: "searchgres.v1.search", params: { fulltext: "compiled" } },
    ]);
  } finally {
    api.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
