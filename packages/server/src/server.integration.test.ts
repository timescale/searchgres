import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
    cmd: [sg, "server", "--config", configPath],
    env: { ...process.env, [databaseEnvironment]: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForReady(serverUrl, server);
});

async function assertCliCommands(): Promise<void> {
  const server = serverUrl.toString().replace(/\/$/, "");
  expect(JSON.parse(await runSg(["info", "--server", server]))).toMatchObject({
    apiVersion: "v1",
    capabilities: { readOnly: false },
  });
  const created = JSON.parse(
    await runSg([
      "upsert",
      "--server",
      server,
      "--input",
      '{"record":{"content":"A CLI cat","tree":"cli","name":"cat"}}',
    ]),
  ) as { readonly result: { readonly id: string } };
  expect(created.result.id).toBeString();
  expect(
    JSON.parse(
      await runSg(["get", "--server", server, "--id", created.result.id]),
    ),
  ).toMatchObject({
    record: { name: "cat" },
  });
  expect(await runSg(["tree", "cli", "--server", server])).toContain("cli (1)");
  expect(
    await runSg([
      "upsert-many",
      "--server",
      server,
      "--input",
      '{"records":[{"content":"one"},{"content":"two"}]}',
      "--output-format",
      "ndjson",
    ]),
  ).toContain("inserted");
  await assertSearchFilterFlags(server);
}

/**
 * Every filter-leaf flag `sg search` exposes, against records planted for the
 * purpose. Each assertion pins the leaf's *discriminating* power — it must
 * match the intended record and exclude the others — so a flag wired to the
 * wrong filter key fails here rather than silently returning everything.
 */
async function assertSearchFilterFlags(server: string): Promise<void> {
  await runSg([
    "upsert-many",
    "--server",
    server,
    "--input",
    JSON.stringify({
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
    }),
  ]);

  const names = async (args: readonly string[]): Promise<readonly string[]> => {
    const output = JSON.parse(
      await runSg(["search", "--server", server, ...args]),
    ) as { readonly results: readonly { readonly name: string | null }[] };
    return output.results.map((result) => result.name ?? "");
  };

  // Each leaf must match its intended record and exclude the other, so a flag
  // wired to the wrong filter key fails here rather than quietly matching
  // everything. Run the cases concurrently: they are read-only and independent,
  // and spawning the binary dominates this suite's runtime.
  const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
    // Tree containment, lquery patterns, ltxtquery word matching.
    [["--tree", "filters.alpha"], ["alpha"]],
    [
      ["--tree", "filters"],
      ["alpha", "beta"],
    ],
    [["--lquery", "filters.beta"], ["beta"]],
    [["--ltxtquery", "alpha"], ["alpha"]],
    // Metadata by equality and by JSONPath predicate.
    [["--meta", '{"colour":"red"}'], ["alpha"]],
    [["--meta-predicate", "$.size > 50"], ["beta"]],
    // `within`/`overlaps` take a start,end window; the point leaves take one
    // instant.
    [
      ["--temporal-within", "2024-02-01T00:00:00Z,2024-04-01T00:00:00Z"],
      ["alpha"],
    ],
    [
      ["--temporal-overlaps", "2024-05-15T00:00:00Z,2024-06-15T00:00:00Z"],
      ["beta"],
    ],
    [["--temporal-before", "2024-04-01T00:00:00Z"], ["alpha"]],
    [["--temporal-after", "2024-04-01T00:00:00Z"], ["beta"]],
    [["--temporal-contains", "2024-03-01T12:00:00Z"], ["alpha"]],
    // Several leaves AND together; a contradictory pair matches nothing.
    [["--tree", "filters", "--meta", '{"colour":"blue"}'], ["beta"]],
    [["--tree", "filters.alpha", "--meta-predicate", "$.size > 50"], []],
    // regexp is not indexable, so it may not stand alone — but it composes.
    [["--tree", "filters", "--regexp", "probe be+ta"], ["beta"]],
    // Filters compose with a ranking arm.
    [["--fulltext", "beta", "--tree", "filters"], ["beta"]],
    // Ordering and paging apply to a filter-only listing.
    [["--tree", "filters", "--order", "asc", "--limit", "1"], ["alpha"]],
  ];
  const matched = await Promise.all(cases.map(([args]) => names(args)));
  for (const [index, [args, expected]] of cases.entries()) {
    expect(matched[index]?.toSorted(), `sg search ${args.join(" ")}`).toEqual([
      ...expected,
    ]);
  }

  await expect(
    runSg(["search", "--server", server, "--regexp", "probe"]),
  ).rejects.toThrow(/indexable filter/);

  // Malformed flag values are rejected with an actionable message rather than
  // reaching the server.
  await expect(
    runSg(["search", "--server", server, "--meta", "not-json"]),
  ).rejects.toThrow(/--meta must be valid JSON/);
  // Independent of each other and of any server state, so spawn them together:
  // binary startup dominates this suite's runtime.
  // The knobs that are not search criteria on their own are paired with a
  // filter; otherwise the "no criteria" guard fires before the value is parsed.
  const invalid: readonly (readonly [readonly string[], RegExp])[] = [
    [["--meta", '["array"]'], /--meta must be a JSON object/],
    [["--temporal-within", "only-one"], /"start,end" range/],
    [
      ["--tree", "filters", "--order", "sideways"],
      /--order must be one of asc, desc/,
    ],
    [["--semantic", "probe", "--semantic-threshold", "7"], /between 0 and 1/],
    [[], /requires --input, a ranking flag/],
  ];
  const failures = await Promise.all(
    invalid.map(([args]) =>
      runSg(["search", "--server", server, ...args]).then(
        () => "",
        (error: unknown) => String(error),
      ),
    ),
  );
  for (const [index, [args, pattern]] of invalid.entries()) {
    expect(failures[index], `sg search ${args.join(" ")}`).toMatch(pattern);
  }

  // A user error is one line on stderr, not a stack trace through the compiled
  // bundle. Assert on the whole output so a regression that reintroduces the
  // trace fails here.
  const rejection = await runSg([
    "search",
    "--server",
    server,
    "--meta",
    "not-json",
  ]).catch((error: unknown) => String(error));
  expect(rejection).not.toContain("at <anonymous>");
  expect(rejection).not.toContain("$bunfs");
}

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
