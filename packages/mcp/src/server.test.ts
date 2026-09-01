import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createClient,
  createSearchgresClient,
  type RpcTransport,
  SearchgresTransportError,
} from "@searchgres/client";
import { createMcpServer, READ_TOOL_NAMES, TOOL_NAMES } from "./server.ts";

const id = "01900000-0000-7000-8000-000000000001";
const record = {
  id,
  content: "A😀 long record",
  meta: { kind: "guide" },
  tree: "docs",
  name: "guide",
  temporal: null,
  hasEmbedding: true,
  version: "1",
  versionHash: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

type Capture = {
  method: string;
  params?: unknown;
  signal: AbortSignal | undefined;
};

function transport(
  captures: Capture[],
  override?: RpcTransport["send"],
): RpcTransport {
  return {
    async send(request, signal) {
      if (override) return override(request, signal);
      const call = request as { id: string; method: string; params?: unknown };
      captures.push({ method: call.method, params: call.params, signal });
      let result: unknown;
      if (call.method.endsWith("server.info")) {
        result = {
          apiVersion: "v1",
          serverVersion: "0.0.0",
          maxRequestBodyBytes: 1_048_576,
          capabilities: {
            semanticText: true,
            fulltext: true,
            userSuppliedVectors: false,
            workerManagedByServer: true,
            readOnly: false,
          },
        };
      } else if (call.method.endsWith("search"))
        result = { results: [{ ...record, score: 0.8 }] };
      else if (
        call.method.includes("record.get") ||
        call.method.endsWith("record.patch")
      )
        result = { record };
      else if (call.method.includes("record.insert"))
        result = call.method.endsWith("Many")
          ? { results: [{ id, status: "inserted" }] }
          : { result: { id, status: "inserted" } };
      else if (call.method.includes("tree.count"))
        result = { count: 1, capped: false };
      else if (call.method.includes("tree.view"))
        result = { entries: [{ tree: "docs", count: 1 }] };
      else if (call.method.includes("tree.")) result = { count: 1 };
      else result = {};
      return { jsonrpc: "2.0", id: call.id, result };
    },
  };
}

async function connect(
  options: {
    readOnly?: boolean;
    timeoutMs?: number;
    transport?: RpcTransport;
    reportError?: (error: unknown) => void;
  } = {},
) {
  const captures: Capture[] = [];
  const server = createMcpServer({
    client: createClient({
      transport: options.transport ?? transport(captures),
    }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    reportError: options.reportError ?? (() => {}),
  });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { captures, server, client };
}

async function close(
  server: ReturnType<typeof createMcpServer>,
  client: Client,
) {
  await Promise.all([server.close(), client.close()]);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = (
    result.content as Array<{ type: string; text?: string }> | undefined
  )?.[0];
  if (content?.type !== "text") throw new Error("missing text result");
  if (content.text === undefined) throw new Error("missing text value");
  return JSON.parse(content.text) as unknown;
}

test("registers twelve tools by default and only reads in read-only mode", async () => {
  for (const readOnly of [false, true]) {
    const { server, client } = await connect({ readOnly });
    try {
      const tools = (await client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual([...(readOnly ? READ_TOOL_NAMES : TOOL_NAMES)]);
      for (const tool of tools) {
        expect(tool.description).toContain(`/docs/mcp/${tool.name}.md`);
        expect(tool.annotations?.openWorldHint).toBe(true);
        expect(tool.outputSchema).toBeUndefined();
      }
      const searchSchema = JSON.stringify(
        tools.find((tool) => tool.name === "searchgres_search")?.inputSchema,
      );
      for (const token of [
        "and",
        "or",
        "not",
        "tree",
        "lquery",
        "ltxtquery",
        "metaPredicate",
        "temporalWithin",
        "temporalOverlaps",
        "regexp",
      ]) {
        expect(searchSchema).toContain(token);
      }
      expect(searchSchema).toContain("$ref");
    } finally {
      await close(server, client);
    }
  }
});

test("search and get project locally without presentation RPC params", async () => {
  const { captures, server, client } = await connect();
  try {
    const search = await client.callTool({
      name: "searchgres_search",
      arguments: {
        semantic: "documentation",
        fulltext: null,
        filter: { and: [{ tree: "docs" }, { meta: { kind: "guide" } }] },
        select: ["id", "score", "content:2"],
      },
    });
    expect(text(search)).toEqual({
      results: [{ id, content: "A😀", contentLength: 14, score: 0.8 }],
    });
    expect(search.structuredContent).toBeUndefined();
    expect(captures[0]?.params).toEqual({
      semantic: "documentation",
      filter: { and: [{ tree: "docs" }, { meta: { kind: "guide" } }] },
    });

    const get = await client.callTool({
      name: "searchgres_get",
      arguments: { tree: "docs", name: "guide", select: ["id", "meta.kind"] },
    });
    expect(text(get)).toEqual({ record: { id, meta: { kind: "guide" } } });
    expect(captures[1]?.params).toEqual({ tree: "docs", name: "guide" });
  } finally {
    await close(server, client);
  }
});

test("real fetch client sends normalized wire params without local selection", async () => {
  let body: { params?: unknown } | undefined;
  const searchgres = createSearchgresClient({
    url: "http://searchgres.invalid/rpc",
    fetch: (async (_input, init) => {
      body = JSON.parse(String(init?.body));
      const request = body as { id: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { results: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const mcp = createMcpServer({ client: searchgres });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    mcp.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    await client.callTool({
      name: "searchgres_search",
      arguments: { semantic: "docs", fulltext: null, select: ["id"] },
    });
    expect(body?.params).toEqual({ semantic: "docs" });
  } finally {
    await close(mcp, client);
  }
});

test("write and tree tools map to the existing client methods", async () => {
  const { captures, server, client } = await connect();
  try {
    const calls = [
      ["searchgres_create", { record: { content: "one", tree: null } }],
      ["searchgres_create_many", { records: [{ content: "one" }] }],
      [
        "searchgres_update",
        { id, priorVersionHash: "hash", patch: { content: "two" } },
      ],
      ["searchgres_delete", { id }],
      ["searchgres_move_tree", { source: "a", destination: "b", dryRun: true }],
      [
        "searchgres_copy_tree",
        { source: "a", destination: "b", dryRun: false },
      ],
      ["searchgres_delete_tree", { tree: "a", dryRun: true }],
      ["searchgres_tree", { tree: "", levels: 2 }],
      ["searchgres_count", { selector: { lquery: "docs.*" }, limit: 10 }],
      ["searchgres_info", {}],
    ] as const;
    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(result.isError).not.toBe(true);
    }
    expect(captures.map((capture) => capture.method)).toEqual([
      "searchgres.v1.record.insert",
      "searchgres.v1.record.insertMany",
      "searchgres.v1.record.patch",
      "searchgres.v1.record.delete",
      "searchgres.v1.tree.move",
      "searchgres.v1.tree.copy",
      "searchgres.v1.tree.delete",
      "searchgres.v1.tree.view",
      "searchgres.v1.tree.count",
      "searchgres.v1.server.info",
    ]);
    expect(captures[4]?.params).toEqual({
      source: "a",
      destination: "b",
      options: { dryRun: true },
    });
  } finally {
    await close(server, client);
  }
});

test("operation timeout aborts the client call and returns a safe error", async () => {
  let aborted = false;
  const hanging: RpcTransport = {
    async send(_request, signal) {
      await new Promise<void>((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
      throw new SearchgresTransportError("secret timeout detail");
    },
  };
  const { server, client } = await connect({
    transport: hanging,
    timeoutMs: 5,
  });
  try {
    const result = await client.callTool({
      name: "searchgres_info",
      arguments: {},
    });
    expect(aborted).toBe(true);
    expect(text(result)).toEqual({
      error: { code: "TIMEOUT", message: "Searchgres operation timed out." },
    });
  } finally {
    await close(server, client);
  }
});

test("unexpected errors are reported locally but sanitized for the model", async () => {
  const reported: unknown[] = [];
  const broken: RpcTransport = {
    async send() {
      throw new Error("SECRET_INTERNAL_DETAIL");
    },
  };
  const { server, client } = await connect({
    transport: broken,
    reportError: (error) => reported.push(error),
  });
  try {
    const result = await client.callTool({
      name: "searchgres_info",
      arguments: {},
    });
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("SECRET_INTERNAL_DETAIL");
    expect(JSON.stringify(text(result))).toEqual(
      '{"error":{"code":"INTERNAL","message":"Unexpected Searchgres MCP error."}}',
    );
  } finally {
    await close(server, client);
  }
});

test("invalid selection and domain and transport errors are safe text errors", async () => {
  let call = 0;
  const custom: RpcTransport = {
    async send(request) {
      call += 1;
      const rpc = request as { id: string };
      if (call === 1)
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: -32001,
            message: "stale",
            data: { searchgresCode: "STALE" },
          },
        };
      throw new SearchgresTransportError("request failed", {
        cause: new Error("SECRET_NETWORK_DETAIL"),
      });
    },
  };
  const { server, client } = await connect({ transport: custom });
  try {
    const invalid = await client.callTool({
      name: "searchgres_search",
      arguments: { select: ["nope"] },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(text(invalid))).toContain("INVALID_INPUT");

    const domain = await client.callTool({
      name: "searchgres_info",
      arguments: {},
    });
    expect(text(domain)).toEqual({
      error: { code: "STALE", message: "stale" },
    });
    const unavailable = await client.callTool({
      name: "searchgres_info",
      arguments: {},
    });
    expect(JSON.stringify(text(unavailable))).not.toContain("SECRET");
    expect(JSON.stringify(text(unavailable))).toContain("UNAVAILABLE");
  } finally {
    await close(server, client);
  }
});
