import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { createIndex, dropIndex } from "searchgres";
import { createSearchgresClient } from "../../client/src/index.ts";

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const schema = `sgtest_server_${crypto.randomUUID().replaceAll("-", "")}`;
const databaseEnvironment = "SEARCHGRES_SERVER_TEST_DATABASE_URL";
const configPath = `/tmp/searchgres-server-${process.pid}.yaml`;

let sql: Sql;
let fakeEmbeddings: ReturnType<typeof Bun.serve>;
let server: Bun.Subprocess | undefined;
let serverUrl: URL;

afterAll(async () => {
  server?.kill("SIGTERM");
  await server?.exited;
  fakeEmbeddings?.stop(true);
  await rm(configPath, { force: true });
  if (sql) {
    await dropIndex(sql, schema);
    await sql.end();
  }
});

beforeAll(async () => {
  sql = postgres(databaseUrl, { onnotice: () => {} });
  await createIndex(sql, schema, { dimensions: 4 });

  fakeEmbeddings = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/embeddings"
      ) {
        return new Response("Not found", { status: 404 });
      }
      const body = (await request.json()) as {
        readonly input?: string | readonly string[];
      };
      const inputs =
        typeof body.input === "string"
          ? [body.input]
          : Array.isArray(body.input)
            ? body.input
            : [];
      return Response.json({
        object: "list",
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: embeddingFor(input),
        })),
        model: "deterministic-test-model",
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      });
    },
  });

  const port = await unusedPort();
  serverUrl = new URL(`http://127.0.0.1:${port}/`);
  await Bun.write(
    configPath,
    `version: 1
server:
  listen:
    host: 127.0.0.1
    port: ${port}
database:
  urlEnv: ${databaseEnvironment}
index:
  schema: ${schema}
  embedding:
    provider: openai-compatible
    model: deterministic-test-model
    baseUrl: ${fakeEmbeddings.url.toString().replace(/\/$/, "")}/v1
  truncate:
    kind: none
  worker:
    interval: 10ms
    batchSize: 10
`,
  );
  server = Bun.spawn({
    cmd: ["./dist/sg", "server", "--config", configPath],
    env: { ...process.env, [databaseEnvironment]: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForReady(serverUrl, server);
});

test("compiled sg writes through the queue and performs semantic and hybrid search", async () => {
  const client = createSearchgresClient({ url: new URL("rpc", serverUrl) });
  const discovered = await client.discover();
  const discoveredMethods = discovered.methods as readonly {
    readonly name: string;
  }[];
  expect(discoveredMethods.map((method) => method.name)).toContain(
    "searchgres.v1.search",
  );
  const openRpcResponse = await fetch(new URL("openrpc.json", serverUrl));
  expect(openRpcResponse.status).toBe(200);
  expect(
    ((await openRpcResponse.json()) as { readonly openrpc: string }).openrpc,
  ).toBe("1.3.2");

  const upsert = await client.upsertMany({
    records: [
      { content: "A cat naps in the sun", tree: "pets", name: "cat" },
      { content: "A dog chases a ball", tree: "pets", name: "dog" },
    ],
  });
  expect(upsert.results).toHaveLength(2);

  const semantic = await eventually(async () => {
    const result = await client.search({ semantic: "cat", limit: 10 });
    return result.results[0]?.content === "A cat naps in the sun" &&
      result.results[0].hasEmbedding
      ? result
      : undefined;
  });
  expect(semantic.results.map((result) => result.name)).toContain("cat");

  const hybrid = await client.search({
    semantic: "cat",
    fulltext: "cat",
    limit: 10,
  });
  expect(hybrid.results[0]?.name).toBe("cat");
  expect(hybrid.results[0]?.score).toBeGreaterThan(0);
});

function embeddingFor(input: string): number[] {
  const text = input.toLowerCase();
  if (text.includes("cat")) {
    return [1, 0, 0, 0];
  }
  if (text.includes("dog")) {
    return [0, 1, 0, 0];
  }
  return [0, 0, 1, 0];
}

async function unusedPort(): Promise<number> {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = reservation;
  reservation.stop(true);
  if (port === undefined) {
    throw new Error("Bun did not assign an ephemeral port");
  }
  return port;
}

async function waitForReady(url: URL, process: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      const stderr = await processStderr(process);
      throw new Error(`Compiled sg exited before readiness: ${stderr}`);
    }
    try {
      const response = await fetch(new URL("readyz", url));
      if (response.status === 204) {
        return;
      }
    } catch {
      // The listener may not be bound yet.
    }
    await Bun.sleep(25);
  }
  const stderr = await processStderr(process);
  throw new Error(`Timed out waiting for compiled sg readiness: ${stderr}`);
}

async function processStderr(process: Bun.Subprocess): Promise<string> {
  const { stderr } = process;
  return typeof stderr === "number" || stderr === undefined
    ? ""
    : new Response(stderr).text();
}

async function eventually<T>(
  operation: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for the embedding worker", {
    cause: lastError,
  });
}
