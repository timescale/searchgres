import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON5, YAML } from "bun";
import { loadServerConfig } from "./config.ts";

const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("config writes reviewable YAML and support files without a database", async () => {
  const directory = await temporaryDirectory();
  const configPath = join(directory, "searchgres.yaml");
  const result = await run([
    "config",
    ...configArguments(configPath),
    "--base-url",
    "http://127.0.0.1:1/v1",
    "--api-key-env",
    "OFFLINE_EMBEDDING_KEY",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Wrote server config");
  const config = YAML.parse(await Bun.file(configPath).text()) as {
    index: { dimensions: number; vectorType: string };
  };
  expect(config.index).toMatchObject({
    dimensions: 768,
    vectorType: "halfvec",
  });
  expect((await loadServerConfig(configPath)).index).toMatchObject({
    schema: "offline",
    dimensions: 768,
    vectorType: "halfvec",
  });
  expect(await Bun.file(join(directory, ".env.example")).text()).toBe(
    "OFFLINE_DATABASE_URL=\nOFFLINE_EMBEDDING_KEY=\n",
  );
  expect(await Bun.file(join(directory, ".gitignore")).text()).toBe(".env\n");
});

test("config supports JSON5 and dry-run has no filesystem side effects", async () => {
  const directory = await temporaryDirectory();
  const json5Path = join(directory, "server.json5");
  const json5 = await run(["config", ...configArguments(json5Path)]);
  expect(json5.exitCode).toBe(0);
  expect(JSON5.parse(await Bun.file(json5Path).text())).toMatchObject({
    index: { schema: "offline", dimensions: 768, vectorType: "halfvec" },
  });

  const dryDirectory = join(directory, "missing");
  const dryPath = join(dryDirectory, "server.yaml");
  const dryRun = await run([
    "config",
    ...configArguments(dryPath),
    "--dry-run",
  ]);
  expect(dryRun.exitCode).toBe(0);
  expect(YAML.parse(dryRun.stdout)).toMatchObject({
    index: { schema: "offline" },
  });
  expect(await Bun.file(dryDirectory).exists()).toBe(false);
});

test("config refuses overwrite and validates paired tokenizer options", async () => {
  const directory = await temporaryDirectory();
  const configPath = join(directory, "server.yaml");
  expect((await run(["config", ...configArguments(configPath)])).exitCode).toBe(
    0,
  );

  const repeated = await run(["config", ...configArguments(configPath)]);
  expect(repeated.exitCode).toBe(1);
  expect(repeated.stderr).toContain("Config file already exists");

  const invalidPath = join(directory, "invalid.yaml");
  const invalid = await run([
    "config",
    ...configArguments(invalidPath),
    "--tokenizer",
    "nomic-embed-text-v1.5",
  ]);
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toContain(
    "--tokenizer and --max-tokens must be used together",
  );
  expect(await Bun.file(invalidPath).exists()).toBe(false);
});

function configArguments(path: string): string[] {
  return [
    "--config",
    path,
    "--database-url-env",
    "OFFLINE_DATABASE_URL",
    "--schema",
    "offline",
    "--embedding-model",
    "offline-model",
    "--dimensions",
    "768",
  ];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "searchgres-config-test-"));
  directories.push(directory);
  return directory;
}

async function run(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn({
    cmd: [process.execPath, bin, ...args],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          name !== "OFFLINE_DATABASE_URL" && name !== "OFFLINE_EMBEDDING_KEY",
      ),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
