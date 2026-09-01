import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { YAML } from "bun";
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
// The canonical binary, built by `@searchgres/cli`'s compile script. Resolved
// from this file rather than the cwd so there is exactly one `sg` in the repo.
// Both binaries, resolved from this file rather than the cwd. `sg-server` runs
// the server; `sg` is the client the assertions drive.
const sgServer = fileURLToPath(new URL("../dist/sg-server", import.meta.url));
const sg = fileURLToPath(new URL("../../cli/dist/sg", import.meta.url));

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
    cmd: [sgServer, "serve", "--config", configPath],
    env: { ...process.env, [databaseEnvironment]: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForReady(serverUrl, server);
});

async function assertCliCommands(): Promise<void> {
  const server = serverUrl.toString().replace(/\/$/, "");
  expect(
    JSON.parse(await runSg(["--json", "info", "--server", server])),
  ).toMatchObject({
    apiVersion: "v1",
    maxRequestBodyBytes: 1024 * 1024,
    capabilities: { readOnly: false },
  });
  const created = JSON.parse(
    await runSg([
      "--json",
      "create",
      "--server",
      server,
      "--content",
      "A CLI cat",
      "--tree",
      "cli",
      "--name",
      "cat",
    ]),
  ) as {
    readonly result: { readonly id: string };
    readonly record: { readonly versionHash: string };
  };
  expect(created.result.id).toBeString();
  expect(
    JSON.parse(
      await runSg(["--json", "get", created.result.id, "--server", server]),
    ),
  ).toMatchObject({ record: { name: "cat" } });
  expect(
    JSON.parse(
      await runSg([
        "--json",
        "update",
        created.result.id,
        "--server",
        server,
        "--version-hash",
        created.record.versionHash,
        "--meta",
        '{"source":"cli"}',
      ]),
    ),
  ).toMatchObject({ record: { meta: { source: "cli" } } });
  expect(await runSg(["tree", "cli", "--server", server])).toContain("cli (1)");

  const importPath = `/tmp/searchgres-import-${process.pid}.ndjson`;
  const createPath = `/tmp/searchgres-create-${process.pid}.yaml`;
  const exportPath = `/tmp/searchgres-export-${process.pid}.json`;
  try {
    await Promise.all([
      Bun.write(
        importPath,
        '{"content":"one","tree":"cli.bulk","name":"one","temporal":["2024-01-01T00:00:00Z"]}\n{"content":"two","tree":"cli.bulk","name":"two"}\n',
      ),
      Bun.write(
        createPath,
        "content: from a structured file\ntree: cli.files\nname: yaml\n",
      ),
    ]);
    expect(
      await runSg(["create", "--file", createPath, "--server", server]),
    ).toContain("status: inserted");
    expect(await runSg(["import", importPath, "--server", server])).toContain(
      "inserted: 2",
    );
    await runSg([
      "export",
      exportPath,
      "--server",
      server,
      "--format",
      "json",
      "--tree",
      "cli.bulk",
    ]);
    const exported = JSON.parse(await Bun.file(exportPath).text()) as readonly {
      readonly content: string;
      readonly temporal?: readonly string[];
    }[];
    expect(exported.map((record) => record.content)).toEqual(["one", "two"]);
    expect(exported[0]?.temporal).toEqual(["2024-01-01T00:00:00.000Z"]);
    expect(
      await runSg([
        "delete",
        "--tree",
        "cli.bulk",
        "--dry-run",
        "--server",
        server,
      ]),
    ).toContain("count: 2");
    await expect(
      runSg(["delete", "--tree", "cli.bulk", "--server", server]),
    ).rejects.toThrow(/requires --yes/);
    expect(
      await runSg([
        "delete",
        "--tree",
        "cli.bulk",
        "--yes",
        "--server",
        server,
      ]),
    ).toContain("count: 2");
  } finally {
    await Promise.all([
      rm(importPath, { force: true }),
      rm(createPath, { force: true }),
      rm(exportPath, { force: true }),
    ]);
  }
  await assertSearchFilterFlags(server);
}

async function assertLocalSearchSelection(server: string): Promise<void> {
  const command = [
    "search",
    "--server",
    server,
    "--tree",
    "filters",
    "--select",
    "id,content:2,score",
  ];

  const json = JSON.parse(await runSg(["--json", ...command])) as {
    readonly results: readonly Record<string, unknown>[];
  };
  expect(json.results).toHaveLength(2);
  for (const result of json.results) {
    expect(Object.keys(result)).toEqual([
      "id",
      "content",
      "contentLength",
      "score",
    ]);
    expect(result.content).toBe("Fi");
  }

  const yaml = YAML.parse(await runSg(["--yaml", ...command])) as {
    readonly results: readonly Record<string, unknown>[];
  };
  expect(yaml).toEqual(json);

  const ndjson = (await runSg(["--ndjson", ...command]))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(ndjson).toEqual([...json.results]);

  await expect(
    runSg([...command.slice(0, -1), "id,content:10,content:-10.."]),
  ).rejects.toThrow(/Invalid --select: only one distinct content selection/);
}

/**
 * The parts of `sg search` that only a real process against a real server can
 * prove: that a flag-built filter reaches PostgreSQL and selects the right
 * rows, that the server's own rules still apply, and that a rejection is a
 * readable message with a non-zero exit.
 *
 * The exhaustive per-leaf flag-to-params matrix lives in
 * packages/cli/src/cli.test.ts, which is pure and needs neither a spawn nor a
 * database. Cases here are chosen for what they exercise beyond that mapping —
 * one representative of each leaf *type* (ltree, JSONB, temporal, regex), not
 * all eleven leaves.
 */
async function assertSearchFilterFlags(server: string): Promise<void> {
  const client = createSearchgresClient({ url: `${server}/rpc` });
  await client.insertMany({
    records: [
      {
        content: "Filter probe alpha",
        tree: "filters.alpha",
        name: "alpha",
        meta: { colour: "red", size: 10 },
        temporal: ["2024-03-01T00:00:00Z", "2024-03-02T00:00:00Z"],
      },
      {
        content: "Filter probe beta",
        tree: "filters.beta",
        name: "beta",
        meta: { colour: "blue", size: 99 },
        temporal: ["2024-06-01T00:00:00Z", "2024-06-02T00:00:00Z"],
      },
    ],
  });

  await assertLocalSearchSelection(server);

  const names = async (args: readonly string[]): Promise<readonly string[]> => {
    const output = JSON.parse(
      await runSg(["--json", "search", "--server", server, ...args]),
    ) as { readonly results: readonly { readonly name: string | null }[] };
    return output.results.map((result) => result.name ?? "").toSorted();
  };

  // One per leaf type, each discriminating between the two records: an ltree
  // containment, a JSONB path predicate, a temporal window, and a regex that
  // must be composed with an indexable leaf. Together these prove the flags
  // survive JSON-RPC, Zod, and the SQL routine — which the unit test cannot.
  const [tree, predicate, temporal, regexp, conjunction] = await Promise.all([
    names(["--tree", "filters.alpha"]),
    names(["--meta-predicate", "$.size > 50"]),
    names(["--temporal-within", "2024-02-01T00:00:00Z,2024-04-01T00:00:00Z"]),
    names(["--tree", "filters", "--regexp", "probe be+ta"]),
    names(["--tree", "filters", "--meta", '{"colour":"blue"}']),
  ]);
  expect(tree).toEqual(["alpha"]);
  expect(predicate).toEqual(["beta"]);
  expect(temporal).toEqual(["alpha"]);
  expect(regexp).toEqual(["beta"]);
  // Several flags ANDed: both leaves must apply, not just the last one.
  expect(conjunction).toEqual(["beta"]);

  // Server-side rules the CLI does not (and should not) duplicate.
  await expect(
    runSg(["search", "--server", server, "--regexp", "probe"]),
  ).rejects.toThrow(/indexable filter/);

  // A rejected invocation exits non-zero with a single readable line — not a
  // stack trace pointing into the compiled bundle. Only the real binary can
  // show this.
  const rejection = await runSg([
    "search",
    "--server",
    server,
    "--meta",
    "not-json",
  ]).catch((error: unknown) => String(error));
  expect(rejection).toMatch(/--meta must be valid JSON/);
  expect(rejection).not.toContain("at <anonymous>");
  expect(rejection).not.toContain("$bunfs");
}

test("compiled sg writes through the queue and performs semantic and hybrid search", async () => {
  const client = createSearchgresClient({ url: new URL("rpc", serverUrl) });
  expect((await client.info()).maxRequestBodyBytes).toBe(1024 * 1024);
  const oversized = await fetch(new URL("rpc", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x".repeat(1024 * 1024) }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toMatchObject({
    error: { message: "Request body exceeds 1048576 bytes" },
  });
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

  const cat = await client.getByName({ tree: "pets", name: "cat" });
  expect(cat.record.content).toBe("A cat naps in the sun");
  expect((await client.get({ id: cat.record.id })).record.name).toBe("cat");
  const patched = await client.patch({
    id: cat.record.id,
    priorVersionHash: cat.record.versionHash,
    patch: { meta: { species: "cat" } },
  });
  expect(patched.record.meta).toEqual({ species: "cat" });

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

  const bird = await client.upsert({
    record: { content: "A bird sings", tree: "pets", name: "bird" },
  });
  expect(bird.result.status).toBe("inserted");
  expect(
    (
      await client.insert({
        record: { content: "A fish swims", tree: "pets", name: "fish" },
      })
    ).result.status,
  ).toBe("inserted");
  expect(
    (
      await client.insertMany({
        records: [
          { content: "A hamster runs", tree: "pets", name: "hamster" },
          { content: "A lizard rests", tree: "pets", name: "lizard" },
        ],
      })
    ).results,
  ).toHaveLength(2);
  await client.delete({ id: bird.result.id });
  await client.deleteByName({ tree: "pets", name: "fish" });

  expect(
    (
      await client.moveTree({
        source: "pets",
        destination: "animals",
        options: { dryRun: true },
      })
    ).count,
  ).toBe(4);
  expect(
    (await client.moveTree({ source: "pets", destination: "animals" })).count,
  ).toBe(4);
  expect(
    await client.countTree({ selector: { tree: "animals" }, limit: 3 }),
  ).toEqual({
    count: 3,
    capped: true,
  });
  expect(
    (await client.listTree({ lquery: "animals.*" })).entries.find(
      (entry) => entry.tree === "animals",
    )?.count,
  ).toBe(4);
  expect(
    (await client.copyTree({ source: "animals", destination: "zoo" })).count,
  ).toBe(4);
  expect(
    (await client.deleteTree({ tree: "zoo", options: { dryRun: true } })).count,
  ).toBe(4);
  expect((await client.deleteTree({ tree: "zoo" })).count).toBe(4);
  await assertCliCommands();
  // Well beyond Bun's 5s default: this test spawns the compiled binary a few
  // dozen times, and process startup dominates. A CI runner is slower than a
  // developer machine, so the default budget is not a useful signal here.
}, 120_000);

async function runSg(args: readonly string[]): Promise<string> {
  const process = Bun.spawn({
    cmd: [sg, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`sg failed (${exitCode}): ${stderr}`);
  return stdout.trim();
}

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
