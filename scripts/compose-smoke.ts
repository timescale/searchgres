import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const project = `searchgres-smoke-${randomBytes(5).toString("hex")}`;
const serverUrl = "http://127.0.0.1:3000";
const databaseRecordId = "01950000-0000-7000-8000-000000000001";
const recipeRecordId = "01950000-0000-7000-8000-000000000002";
let cleaningUp = false;
let failed = false;

async function compose(
  args: readonly string[],
  options: { readonly capture?: boolean; readonly allowFailure?: boolean } = {},
): Promise<string> {
  console.log(`+ docker compose -p ${project} ${args.join(" ")}`);
  const capture = options.capture ?? false;
  const process = Bun.spawn(["docker", "compose", "-p", project, ...args], {
    stdin: "inherit",
    stdout: capture ? "pipe" : "inherit",
    stderr: capture ? "pipe" : "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    capture ? new Response(process.stdout).text() : Promise.resolve(""),
    capture ? new Response(process.stderr).text() : Promise.resolve(""),
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    if (stdout) processOutput(stdout, false);
    if (stderr) processOutput(stderr, true);
    throw new Error(`docker compose exited with status ${exitCode}`);
  }
  return stdout;
}

function processOutput(output: string, error: boolean): void {
  (error ? process.stderr : process.stdout).write(output);
}

async function cli(args: readonly string[]): Promise<unknown> {
  const output = await compose(
    [
      "exec",
      "-T",
      "server",
      "searchgres",
      "--server",
      serverUrl,
      "--json",
      ...args,
    ],
    { capture: true },
  );
  return JSON.parse(output);
}

async function waitForEmbedding(id: string): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = (await cli(["get", id])) as {
      readonly record?: { readonly hasEmbedding?: boolean };
    };
    if (result.record?.hasEmbedding === true) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`embedding queue did not complete record ${id}`);
}

function assertSearchContains(value: unknown, id: string, mode: string): void {
  const result = value as {
    readonly results?: readonly { readonly id?: string }[];
  };
  assert.ok(
    result.results?.some((record) => record.id === id),
    `${mode} search did not return ${id}`,
  );
}

async function cleanup(): Promise<void> {
  if (cleaningUp) return;
  cleaningUp = true;
  if (failed) {
    await compose(["ps"], { allowFailure: true });
    await compose(["logs", "--no-color"], { allowFailure: true });
  }
  await compose(["down", "-v", "--remove-orphans"], { allowFailure: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    failed = true;
    void cleanup().finally(() => process.exit(128));
  });
}

try {
  await compose(["up", "-d", "--build", "--wait", "--wait-timeout", "900"]);
  await cli(["info"]);

  await cli([
    "create",
    "--id",
    databaseRecordId,
    "--content",
    "Postgres-native semantic and BM25 database search with pgtextsearchmarker.",
    "--tree",
    "docs",
    "--name",
    "database-search",
  ]);
  await cli([
    "create",
    "--id",
    recipeRecordId,
    "--content",
    "A chocolate cake recipe uses cocoa, flour, and sugar with cakemarker.",
    "--tree",
    "recipes",
    "--name",
    "chocolate-cake",
  ]);
  await Promise.all([
    waitForEmbedding(databaseRecordId),
    waitForEmbedding(recipeRecordId),
  ]);

  assertSearchContains(
    await cli(["search", "--semantic", "database search", "--limit", "2"]),
    databaseRecordId,
    "semantic",
  );
  assertSearchContains(
    await cli(["search", "--fulltext", "pgtextsearchmarker", "--limit", "2"]),
    databaseRecordId,
    "BM25",
  );
  assertSearchContains(
    await cli([
      "search",
      "--semantic",
      "database search",
      "--fulltext",
      "pgtextsearchmarker",
      "--limit",
      "2",
    ]),
    databaseRecordId,
    "hybrid",
  );

  await compose(["stop"]);
  await compose(["up", "-d", "--wait", "--wait-timeout", "300"]);
  const provisionOutput = await compose(["run", "--rm", "provision"], {
    capture: true,
  });
  assert.match(provisionOutput, /already exists and matches the server config/);
  const persisted = (await cli(["get", databaseRecordId])) as {
    readonly record?: { readonly id?: string };
  };
  assert.equal(persisted.record?.id, databaseRecordId);

  console.log("Evaluation Compose smoke test passed");
} catch (error) {
  failed = true;
  throw error;
} finally {
  await cleanup();
}
