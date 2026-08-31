import { mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { JSON5, YAML } from "bun";
import postgres from "postgres";
import { createIndex } from "searchgres";
import { parseServerConfig } from "./config.ts";
import { startServer } from "./server.ts";

const usage = `Usage:
  sg server --config <config.yaml|config.json5>
  sg init --config <path> --database-url-env <name> --schema <schema>
          --embedding-model <model> --dimensions <n> [options]

Init options:
  --host <host>                    Default: 127.0.0.1
  --port <port>                    Default: 3000
  --allow-public-listen             Required for a non-loopback host
  --vector-type <vector|halfvec>   Default: halfvec
  --api-key-env <name>
  --base-url <url>
  --tokenizer <preset> --max-tokens <n>
  --dry-run
`;

export async function runCommand(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "server") {
    await runServer(args);
    return;
  }
  if (command === "init") {
    await runInit(args);
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    console.log(usage);
    return;
  }
  throw new Error(usage);
}

async function runServer(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
  const configPath = requiredFlag(flags, "config");
  rejectUnknownFlags(flags, new Set(["config"]));
  const { loadServerConfig } = await import("./config.ts");
  const config = await loadServerConfig(configPath);
  const server = await startServer(config);
  console.log(`searchgres server listening on ${server.url}`);

  const stop = async () => {
    await server.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function runInit(args: readonly string[]): Promise<void> {
  const flags = parseFlags(args);
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

function renderConfig(path: string, config: unknown): string {
  if (path.toLowerCase().endsWith(".json5")) {
    return `${JSON5.stringify(config, null, 2)}\n`;
  }
  if (
    path.toLowerCase().endsWith(".yaml") ||
    path.toLowerCase().endsWith(".yml")
  ) {
    return `${YAML.stringify(config)}\n`;
  }
  throw new Error("Config path must end in .yaml, .yml, or .json5");
}

function parseFlags(args: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--"))
      throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = args[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (flags.has(name)) throw new Error(`Repeated flag: --${name}`);
    flags.set(name, value);
    if (value !== true) index += 1;
  }
  return flags;
}
function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (!value || value === true) throw new Error(`--${name} is required`);
  return value;
}
function optionalFlag(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value;
}
function rejectUnknownFlags(
  flags: Map<string, string | true>,
  allowed: ReadonlySet<string>,
): void {
  for (const name of flags.keys())
    if (!allowed.has(name)) throw new Error(`Unknown flag: --${name}`);
}
function positiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`--${name} must be a positive integer`);
  return number;
}
function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
