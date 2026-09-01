// `sg-server`: the privileged binary. Creates and destroys indexes and runs the
// server, so it is the only artifact that needs a database connection, provider
// credentials, and the server runtime.
//
// It is separate from `sg` because `bun build --compile` initializes a binary's
// whole module graph at startup whether or not a command uses it: a single
// binary would make every `sg search` pay for postgres, the embedding provider,
// and the interactive prompt library. Flag plumbing and structured I/O are
// shared with `sg` through @searchgres/cli.
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { loadDotenv, writeDotenvExample } from "@searchgres/cli/dotenv";
import {
  type Flags,
  flagsFromOptions,
  isLoopbackHost,
  optionalFlag,
  positiveInteger,
  rejectUnknownFlags,
  requiredFlag,
} from "@searchgres/cli/flags";
import { renderConfig } from "@searchgres/cli/format";
import postgres from "postgres";
import { createIndex, dropIndex } from "searchgres";
import { loadServerConfig, parseServerConfig } from "./config.ts";
import { startServer } from "./server.ts";

const usage = `Usage:
  sg-server init [--config <path> --database-url-env <name> --schema <schema>
                  --embedding-model <model> --dimensions <n> [options]]
  sg-server serve --config <config.yaml|config.json5>
                  [--env-file <path>|--no-env-file] [--read-only]
  sg-server destroy --config <config.yaml|config.json5> --yes

Run \`sg-server <command> --help\` for a command's options. Everyday record and
search commands live in the \`sg\` binary.
`;

export async function runServerCommand(
  command: string,
  flags: Flags,
): Promise<void> {
  if (command === "serve" || command === "server") {
    await runServe(flags);
    return;
  }
  if (command === "init") {
    await runInit(flags);
    return;
  }
  if (command === "destroy") {
    await runDestroy(flags);
    return;
  }
  throw new Error(usage);
}

async function runServe(flags: Map<string, string | true>): Promise<void> {
  const configPath = requiredFlag(flags, "config");
  rejectUnknownFlags(
    flags,
    new Set(["config", "env-file", "no-env-file", "read-only"]),
  );
  if (flags.has("env-file") && flags.has("no-env-file")) {
    throw new Error("--env-file and --no-env-file cannot be used together");
  }
  if (!flags.has("no-env-file")) {
    await loadDotenv(
      optionalFlag(flags, "env-file") ??
        join(dirname(resolve(configPath)), ".env"),
    );
  }
  const config = await loadServerConfig(configPath);
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

async function runDestroy(flags: Map<string, string | true>): Promise<void> {
  rejectUnknownFlags(flags, new Set(["config", "yes"]));
  if (!flags.has("yes")) {
    throw new Error("sg destroy is destructive; pass --yes to confirm");
  }
  const configPath = requiredFlag(flags, "config");
  const config = await loadServerConfig(configPath);
  const databaseUrl = process.env[config.database.urlEnv];
  if (!databaseUrl) {
    throw new Error(
      `Environment variable ${config.database.urlEnv} is required to destroy this index`,
    );
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await dropIndex(sql, config.index.schema);
  } finally {
    await sql.end();
  }
  console.log(`Destroyed index ${JSON.stringify(config.index.schema)}`);
}

async function runInit(flags: Map<string, string | true>): Promise<void> {
  if (flags.size === 0 && process.stdin.isTTY) {
    await runInitWizard();
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
  const databaseUrlEnv = requiredFlag(flags, "database-url-env");
  const schema = requiredFlag(flags, "schema");
  const model = requiredFlag(flags, "embedding-model");
  const dimensions = positiveInteger(
    requiredFlag(flags, "dimensions"),
    "dimensions",
  );
  const host = optionalFlag(flags, "host") ?? "127.0.0.1";
  const port = positiveInteger(optionalFlag(flags, "port") ?? "3000", "port");
  if (!isLoopbackHost(host) && !flags.has("allow-public-listen")) {
    throw new Error(
      "A non-loopback --host requires --allow-public-listen; v1 has no built-in authentication.",
    );
  }
  const config = buildInitialConfig({
    databaseUrlEnv,
    schema,
    model,
    dimensions,
    host,
    port,
    vectorType: optionalFlag(flags, "vector-type") ?? "halfvec",
    apiKeyEnv: optionalFlag(flags, "api-key-env"),
    baseUrl: optionalFlag(flags, "base-url"),
    tokenizer: optionalFlag(flags, "tokenizer"),
    maxTokens: optionalFlag(flags, "max-tokens"),
  });
  const rendered = renderConfig(configPath, config);
  if (flags.has("dry-run")) {
    process.stdout.write(rendered);
    return;
  }
  if (await Bun.file(configPath).exists()) {
    throw new Error(`Config file already exists: ${configPath}`);
  }
  const databaseUrl = process.env[databaseUrlEnv];
  if (!databaseUrl) {
    throw new Error(
      `Environment variable ${databaseUrlEnv} is required for index creation`,
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await createIndex(sql, schema, {
      dimensions,
      vectorType: vectorTypeFromFlags(flags),
    });
  } finally {
    await sql.end();
  }

  const absolutePath = resolve(configPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  try {
    await Bun.write(temporaryPath, rendered);
    await rename(temporaryPath, absolutePath);
    await writeDotenvExample(
      absolutePath,
      databaseUrlEnv,
      optionalFlag(flags, "api-key-env"),
    );
  } catch (error) {
    throw new Error(
      `Index ${JSON.stringify(schema)} was created but config writing failed. Write this config manually:\n${rendered}`,
      { cause: error },
    );
  }
  console.log(
    `Created index ${JSON.stringify(schema)} and config ${configPath}`,
  );
}

async function runInitWizard(): Promise<void> {
  clack.intro("Initialize Searchgres");
  const ask = async (message: string, initialValue?: string) => {
    const answer = await clack.text({
      message,
      ...(initialValue === undefined ? {} : { initialValue }),
      validate: (value) => (value.trim() === "" ? "Required" : undefined),
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Initialization cancelled");
      return undefined;
    }
    return answer;
  };
  const config = await ask("Config path", "searchgres.yaml");
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
    !config ||
    !databaseUrl ||
    !host ||
    !port ||
    !schema ||
    !model ||
    !dimensions
  )
    return;
  const apiKey = await clack.password({
    message: "Embedding API key (leave blank for local providers)",
  });
  if (clack.isCancel(apiKey)) {
    clack.cancel("Initialization cancelled");
    return;
  }
  const databaseEnv = "SEARCHGRES_DATABASE_URL";
  const apiKeyEnv = "SEARCHGRES_EMBEDDING_API_KEY";
  process.env[databaseEnv] = databaseUrl;
  if (apiKey) process.env[apiKeyEnv] = apiKey;
  await runInit(
    flagsFromOptions({
      config,
      databaseUrlEnv: databaseEnv,
      host,
      port,
      allowPublicListen: !isLoopbackHost(host),
      schema,
      embeddingModel: model,
      dimensions,
      ...(apiKey ? { apiKeyEnv } : {}),
    }),
  );
  const envPath = join(dirname(resolve(config)), ".env");
  if (!(await Bun.file(envPath).exists())) {
    await Bun.write(
      envPath,
      `${databaseEnv}=${databaseUrl}\n${apiKey ? `${apiKeyEnv}=${apiKey}\n` : ""}`,
    );
    clack.outro(`Wrote ${envPath}`);
  }
}

function buildInitialConfig(input: {
  readonly databaseUrlEnv: string;
  readonly schema: string;
  readonly model: string;
  readonly dimensions: number;
  readonly host: string;
  readonly port: number;
  readonly vectorType: string;
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
    server: { listen: { host: input.host, port: input.port } },
    database: { urlEnv: input.databaseUrlEnv },
    index: {
      schema: input.schema,
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

function vectorTypeFromFlags(
  flags: Map<string, string | true>,
): "vector" | "halfvec" {
  const value = optionalFlag(flags, "vector-type") ?? "halfvec";
  if (value !== "vector" && value !== "halfvec") {
    throw new Error("--vector-type must be vector or halfvec");
  }
  return value;
}
