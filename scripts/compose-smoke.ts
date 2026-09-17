// Opt-in real-model evaluation through the compiled host CLI, not RPC.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

async function freePort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot allocate test port");
  const port = String(address.port);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const project = `searchgres-smoke-${randomBytes(5).toString("hex")}`;
const environment = {
  ...process.env,
  SEARCHGRES_POSTGRES_PORT: await freePort(),
  SEARCHGRES_OLLAMA_PORT: await freePort(),
};
let cliEnv: Record<string, string | undefined> = {};
async function run(args: string[], env = environment, capture = false) {
  const child = Bun.spawn(args, {
    env,
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
    timeout: 300_000,
    killSignal: "SIGKILL",
  });
  const [code, output] = await Promise.all([
    child.exited,
    capture ? new Response(child.stdout).text() : Promise.resolve(""),
  ]);
  if (code !== 0)
    throw new Error(`Command failed (${code}): ${args.join(" ")}`);
  return output.trim();
}
const compose = (args: string[], capture = false) =>
  run(["docker", "compose", "-p", project, ...args], environment, capture);
async function cli(args: string[]) {
  return JSON.parse(
    await run(
      [
        "./dist/searchgres",
        "--config",
        "docker/evaluation/searchgres.yaml",
        "--no-env-file",
        "--json",
        ...args,
      ],
      { ...environment, ...cliEnv },
      true,
    ),
  );
}
async function endpoints() {
  const db = (await compose(["port", "db", "5432"], true)).split(":").at(-1);
  const ollama = (await compose(["port", "ollama", "11434"], true))
    .split(":")
    .at(-1);
  cliEnv = {
    SEARCHGRES_DATABASE_URL: `postgresql://postgres@127.0.0.1:${db}/postgres`,
    SEARCHGRES_EMBEDDING_BASE_URL: `http://127.0.0.1:${ollama}/v1`,
  };
}
async function waitReady() {
  for (let i = 0; i < 180; i++) {
    try {
      await cli(["info"]);
      return;
    } catch {
      await Bun.sleep(1000);
    }
  }
  throw new Error("Index did not become ready");
}
async function waitJobs() {
  for (const service of ["model", "init"]) {
    let completed = false;
    for (let attempt = 0; attempt < 900; attempt++) {
      const id = await run(
        [
          "docker",
          "ps",
          "-a",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
        ],
        environment,
        true,
      );
      if (id) {
        const state = await run(
          [
            "docker",
            "inspect",
            "--format",
            "{{.State.Status}} {{.State.ExitCode}}",
            id,
          ],
          environment,
          true,
        );
        if (state === "exited 0") {
          completed = true;
          break;
        }
        if (state.startsWith("exited "))
          throw new Error(`${service} failed: ${state}`);
      }
      await Bun.sleep(1000);
    }
    if (!completed) throw new Error(`${service} did not finish`);
  }
}
async function waitEmbedding(id: string) {
  for (let i = 0; i < 180; i++) {
    if ((await cli(["get", id])).record.hasEmbedding) return;
    await Bun.sleep(1000);
  }
  throw new Error("Worker did not embed the record");
}
try {
  await run(["./bun", "run", "compile"]);
  await compose(["up", "-d", "--build"]);
  await endpoints();
  await waitReady();
  // Explicitly check one-shot completion; `up -d` alone is not readiness.
  await waitJobs();
  const first = (
    await cli([
      "create",
      "--content",
      "PostgreSQL indexes make database queries faster",
      "--tree",
      "docs.db",
    ])
  ).record.id;
  await cli([
    "create",
    "--content",
    "Cats enjoy sleeping in warm places",
    "--tree",
    "docs.cats",
  ]);
  await waitEmbedding(first);
  for (const args of [
    ["--semantic", "database indexing"],
    ["--fulltext", "database"],
    ["--semantic", "database indexing", "--fulltext", "database"],
    ["--tree", "docs.db"],
  ]) {
    assert.ok(
      (await cli(["search", ...args])).results.some(
        (r: { id: string }) => r.id === first,
      ),
    );
  }
  // Stop container workers so the host pass must actually embed a new record.
  await compose(["stop", "worker"]);
  const second = (
    await cli([
      "create",
      "--content",
      "More PostgreSQL database material",
      "--tree",
      "docs.db",
    ])
  ).record.id;
  const pass = await cli(["embeddings", "process"]);
  assert.ok(pass.embedded > 0);
  assert.equal((await cli(["get", second])).record.hasEmbedding, true);
  await compose(["down"]);
  await compose(["up", "-d"]);
  await endpoints();
  await waitReady();
  await waitJobs();
  assert.equal((await cli(["init", "--if-not-exists"])).created, false);
  assert.equal((await cli(["get", first])).record.hasEmbedding, true);
  console.log("Direct Compose smoke passed");
} finally {
  await compose(["down", "-v", "--remove-orphans"]);
}
