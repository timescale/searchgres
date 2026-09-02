// `searchgres-server`: the privileged binary. It owns server config, database
// provisioning, provider credentials, worker lifecycle, and serving. Everyday
// record/search commands remain in the independent `searchgres` binary.

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createOpenAI } from "@ai-sdk/openai";
import * as clack from "@clack/prompts";
import postgres, { type Sql } from "postgres";
import { createIndex, dropIndex, openIndex } from "searchgres";
import { loadServerConfig, parseServerConfig } from "./config.ts";
import { renderConfig } from "./config-file.ts";
import { dotenvLine, loadDotenv, writeDotenvExample } from "./dotenv.ts";
import {
  type Flags,
  isLoopbackHost,
  optionalFlag,
  positiveInteger,
  rejectUnknownFlags,
  requiredFlag,
} from "./flags.ts";
import { assertConfiguredIndexShape } from "./index-shape.ts";
import { startServer } from "./server.ts";

const environmentFlags = new Set(["config", "env-file", "no-env-file"]);
const usage = `Usage:
  searchgres-server config [--config <path> --schema <schema> ...]
  searchgres-server init --config <config.yaml|config.json5>
                 [--env-file <path>|--no-env-file] [--if-not-exists]
  searchgres-server serve --config <config.yaml|config.json5>
                  [--env-file <path>|--no-env-file] [--read-only]
  searchgres-server destroy --config <config.yaml|config.json5>
                    [--env-file <path>|--no-env-file] --yes

Run \`searchgres-server <command> --help\` for a command's options. Everyday record and
search commands live in the \`searchgres\` binary.
`;

export async function runServerCommand(
  command: string,
  flags: Flags,
): Promise<void> {
  if (command === "config") {
    await runConfig(flags);
    return;
  }
  if (command === "init") {
    await runInit(flags);
    return;
  }
  if (command === "serve" || command === "server") {
    await runServe(flags);
    return;
  }
  if (command === "destroy") {
    await runDestroy(flags);
    return;
  }
  throw new Error(usage);
}

async function runServe(flags: Flags): Promise<void> {
  rejectUnknownFlags(flags, new Set([...environmentFlags, "read-only"]));
  const { config } = await loadConfiguredCommand(flags);
  const server = await startServer(config, {
    readOnly: flags.has("read-only"),
  });
  console.log(`searchgres server listening on ${server.url}`);

  const stop = async () => {
    await server.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runDestroy(flags: Flags): Promise<void> {
  rejectUnknownFlags(flags, new Set([...environmentFlags, "yes"]));
  if (!flags.has("yes")) {
    throw new Error(
      "searchgres-server destroy is destructive; pass --yes to confirm",
    );
  }
  const { config } = await loadConfiguredCommand(flags);
  const databaseUrl = requiredEnvironment(
    config.database.urlEnv,
    "destroy this index",
  );
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await dropIndex(sql, config.index.schema);
  } finally {
    await sql.end();
  }
  console.log(`Destroyed index ${JSON.stringify(config.index.schema)}`);
}

async function runInit(flags: Flags): Promise<void> {
  rejectUnknownFlags(flags, new Set([...environmentFlags, "if-not-exists"]));
  const { config } = await loadConfiguredCommand(flags);
  const databaseUrl = requiredEnvironment(
    config.database.urlEnv,
    "initialize this index",
  );
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    if (flags.has("if-not-exists")) {
      const created = await createIndexIfMissing(sql, config);
      console.log(
        created
          ? `Created index ${JSON.stringify(config.index.schema)}`
          : `Index ${JSON.stringify(config.index.schema)} already exists and matches the server config`,
      );
    } else {
      await createIndex(sql, config.index.schema, {
        dimensions: config.index.dimensions,
        vectorType: config.index.vectorType,
      });
      console.log(`Created index ${JSON.stringify(config.index.schema)}`);
    }
  } finally {
    await sql.end();
  }
}

async function createIndexIfMissing(
  sql: Sql,
  config: Awaited<ReturnType<typeof loadServerConfig>>,
): Promise<boolean> {
  if (await schemaExists(sql, config.index.schema)) {
    await validateExistingIndex(sql, config);
    return false;
  }

  try {
    await createIndex(sql, config.index.schema, {
      dimensions: config.index.dimensions,
      vectorType: config.index.vectorType,
    });
    return true;
  } catch (error) {
    // The existence check and core's transaction-scoped provisioning lock leave
    // one legitimate race: another process can create this same schema first.
    // Only that exact SQLSTATE is eligible for idempotent validation.
    if (!hasSqlState(error, "42P06")) throw error;
    await validateExistingIndex(sql, config);
    return false;
  }
}

async function schemaExists(sql: Sql, schema: string): Promise<boolean> {
  const [row] = await sql<{ readonly present: boolean }[]>`
    select exists (
      select 1
      from pg_catalog.pg_namespace
      where nspname = ${schema}
    ) as present
  `;
  return row?.present ?? false;
}

async function validateExistingIndex(
  sql: Sql,
  config: Awaited<ReturnType<typeof loadServerConfig>>,
): Promise<void> {
  // openIndex performs no provider I/O. A fixed placeholder key lets it validate
  // schema format/extensions/vector shape without reading the configured secret.
  const provider = createOpenAI({
    apiKey: "searchgres-init-validation",
    ...(config.index.embedding.baseUrl
      ? { baseURL: config.index.embedding.baseUrl }
      : {}),
  });
  const index = await openIndex(sql, config.index.schema, {
    embedding: provider.embedding(config.index.embedding.model),
  });
  assertConfiguredIndexShape(index, config.index);
}

function hasSqlState(error: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === expected) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

async function loadConfiguredCommand(flags: Flags): Promise<{
  readonly configPath: string;
  readonly config: Awaited<ReturnType<typeof loadServerConfig>>;
}> {
  if (flags.has("env-file") && flags.has("no-env-file")) {
    throw new Error("--env-file and --no-env-file cannot be used together");
  }
  const configPath = resolve(requiredFlag(flags, "config"));
  if (!flags.has("no-env-file")) {
    await loadDotenv(
      optionalFlag(flags, "env-file") ?? join(dirname(configPath), ".env"),
    );
  }
  return { configPath, config: await loadServerConfig(configPath) };
}

function requiredEnvironment(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required to ${purpose}`);
  }
  return value;
}

async function runConfig(flags: Flags): Promise<void> {
  if (flags.size === 0 && process.stdin.isTTY) {
    await runConfigWizard();
    return;
  }
  rejectUnknownFlags(
    flags,
    new Set([
      "config",
      "database-url-env",
      "schema",
      "embedding-model",
      "dimensions",
      "host",
      "port",
      "allow-public-listen",
      "vector-type",
      "api-key-env",
      "base-url",
      "tokenizer",
      "max-tokens",
      "dry-run",
    ]),
  );
  const configPath = requiredFlag(flags, "config");
  const host = optionalFlag(flags, "host") ?? "127.0.0.1";
  if (!isLoopbackHost(host) && !flags.has("allow-public-listen")) {
    throw new Error(
      "A non-loopback --host requires --allow-public-listen; v1 has no built-in authentication.",
    );
  }
  const tokenizer = optionalFlag(flags, "tokenizer");
  const maxTokens = optionalFlag(flags, "max-tokens");
  if ((tokenizer === undefined) !== (maxTokens === undefined)) {
    throw new Error("--tokenizer and --max-tokens must be used together");
  }
  const config = buildInitialConfig({
    databaseUrlEnv: requiredFlag(flags, "database-url-env"),
    schema: requiredFlag(flags, "schema"),
    model: requiredFlag(flags, "embedding-model"),
    dimensions: positiveInteger(
      requiredFlag(flags, "dimensions"),
      "dimensions",
    ),
    host,
    port: positiveInteger(optionalFlag(flags, "port") ?? "3000", "port"),
    vectorType: vectorTypeFromFlags(flags),
    apiKeyEnv: optionalFlag(flags, "api-key-env"),
    baseUrl: optionalFlag(flags, "base-url"),
    tokenizer,
    maxTokens,
  });
  const rendered = renderConfig(configPath, config);
  if (flags.has("dry-run")) {
    process.stdout.write(rendered);
    return;
  }
  await writeGeneratedConfig(
    configPath,
    rendered,
    requiredFlag(flags, "database-url-env"),
    optionalFlag(flags, "api-key-env"),
  );
  console.log(`Wrote server config ${configPath}`);
}

async function writeGeneratedConfig(
  configPath: string,
  rendered: string,
  databaseUrlEnv: string,
  apiKeyEnv: string | undefined,
): Promise<void> {
  const absolutePath = resolve(configPath);
  if (await Bun.file(absolutePath).exists()) {
    throw new Error(`Config file already exists: ${configPath}`);
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  try {
    await Bun.write(temporaryPath, rendered);
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Could not write config ${configPath}`, { cause: error });
  }
  try {
    await writeDotenvExample(absolutePath, databaseUrlEnv, apiKeyEnv);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Config ${configPath} was written, but its supporting environment files were not completed${detail}`,
      { cause: error },
    );
  }
}

async function runConfigWizard(): Promise<void> {
  clack.intro("Configure Searchgres");
  const ask = async (message: string, initialValue?: string) => {
    const answer = await clack.text({
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
      validate: (value) => (value.trim() === "" ? "Required" : undefined),
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Configuration cancelled");
      return undefined;
    }
    return answer;
  };
  const configPath = await ask("Config path", "searchgres.yaml");
  const databaseUrl = await ask(
    "Postgres database URL",
    process.env.SEARCHGRES_DATABASE_URL ??
      "postgres://postgres@127.0.0.1:5432/postgres",
  );
  const host = await ask("Server listen host", "127.0.0.1");
  const port = await ask("Server listen port", "3000");
  const schema = await ask("Index schema", "searchgres");
  const model = await ask("Embedding model");
  const dimensions = await ask("Embedding dimensions");
  if (
    !configPath ||
    !databaseUrl ||
    !host ||
    !port ||
    !schema ||
    !model ||
    !dimensions
  ) {
    return;
  }
  if (!isLoopbackHost(host)) {
    const acknowledged = await clack.confirm({
      message:
        "Searchgres v1 has no built-in authentication. Listen publicly anyway?",
      initialValue: false,
    });
    if (clack.isCancel(acknowledged) || !acknowledged) {
      clack.cancel("Configuration cancelled");
      return;
    }
  }
  const baseUrl = await clack.text({
    message: "OpenAI-compatible base URL (leave blank for OpenAI)",
  });
  if (clack.isCancel(baseUrl)) {
    clack.cancel("Configuration cancelled");
    return;
  }
  const apiKey = await clack.password({
    message: "Embedding API key (leave blank for local providers)",
  });
  if (clack.isCancel(apiKey)) {
    clack.cancel("Configuration cancelled");
    return;
  }

  const databaseEnv = "SEARCHGRES_DATABASE_URL";
  const apiKeyEnv = "SEARCHGRES_EMBEDDING_API_KEY";
  const config = buildInitialConfig({
    databaseUrlEnv: databaseEnv,
    schema,
    model,
    dimensions: positiveInteger(dimensions, "dimensions"),
    host,
    port: positiveInteger(port, "port"),
    vectorType: "halfvec",
    apiKeyEnv: apiKey ? apiKeyEnv : undefined,
    baseUrl: baseUrl.trim() === "" ? undefined : baseUrl,
    tokenizer: undefined,
    maxTokens: undefined,
  });
  const rendered = renderConfig(configPath, config);
  await writeGeneratedConfig(
    configPath,
    rendered,
    databaseEnv,
    apiKey ? apiKeyEnv : undefined,
  );

  const envPath = join(dirname(resolve(configPath)), ".env");
  if (await Bun.file(envPath).exists()) {
    clack.outro(`Wrote ${configPath}; kept existing ${envPath}`);
    return;
  }
  let contents: string;
  try {
    contents =
      dotenvLine(databaseEnv, databaseUrl) +
      (apiKey ? dotenvLine(apiKeyEnv, apiKey) : "");
  } catch (error) {
    clack.log.warn(error instanceof Error ? error.message : String(error));
    clack.outro(`Wrote ${configPath}; skipped ${envPath}`);
    return;
  }
  await Bun.write(envPath, contents);
  clack.outro(`Wrote ${configPath} and ${envPath}`);
}

function buildInitialConfig(input: {
  readonly databaseUrlEnv: string;
  readonly schema: string;
  readonly model: string;
  readonly dimensions: number;
  readonly host: string;
  readonly port: number;
  readonly vectorType: "vector" | "halfvec";
  readonly apiKeyEnv: string | undefined;
  readonly baseUrl: string | undefined;
  readonly tokenizer: string | undefined;
  readonly maxTokens: string | undefined;
}): unknown {
  const truncate = input.tokenizer
    ? {
        kind: "tokens",
        tokenizer: input.tokenizer,
        maxTokens: positiveInteger(input.maxTokens ?? "", "max-tokens"),
      }
    : { kind: "none" };
  const config = {
    version: 1,
    server: {
      listen: { host: input.host, port: input.port },
      maxRequestBodyBytes: 1024 * 1024,
    },
    database: { urlEnv: input.databaseUrlEnv },
    index: {
      schema: input.schema,
      dimensions: input.dimensions,
      vectorType: input.vectorType,
      embedding: {
        provider: "openai-compatible",
        model: input.model,
        ...(input.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv } : {}),
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      },
      truncate,
    },
  };
  // Validate the authored wire shape, not the parsed output: duration parsing
  // transforms values and would make a generated config fail when read again.
  parseServerConfig(config);
  return config;
}

function vectorTypeFromFlags(flags: Flags): "vector" | "halfvec" {
  const value = optionalFlag(flags, "vector-type") ?? "halfvec";
  if (value !== "vector" && value !== "halfvec") {
    throw new Error("--vector-type must be vector or halfvec");
  }
  return value;
}
