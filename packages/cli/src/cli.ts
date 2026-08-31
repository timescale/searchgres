import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as clack from "@clack/prompts";
import { createClient, createFetchTransport } from "@searchgres/client";
import {
  loadServerConfig,
  parseServerConfig,
  startServer,
} from "@searchgres/server";
import { JSON5, YAML } from "bun";
import postgres from "postgres";
import { createIndex, dropIndex } from "searchgres";

const usage = `Usage:
  sg server --config <config.yaml|config.json5> [--env-file <path>|--no-env-file]
  sg destroy --config <config.yaml|config.json5> --yes
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

export async function runCommand(
  command: string,
  flags: Map<string, string | true>,
  args: readonly string[] = [],
): Promise<void> {
  if (command === "server") {
    await runServer(flags);
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
  if (command === "tree") {
    await runTree(flags, args);
    return;
  }
  if (command && remoteMethod(command)) {
    await runRemote(command, flags);
    return;
  }
  throw new Error(usage);
}

async function runServer(flags: Map<string, string | true>): Promise<void> {
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

async function runTree(
  flags: Map<string, string | true>,
  args: readonly string[],
): Promise<void> {
  const root = args[0] ?? "";
  rejectUnknownFlags(flags, new Set(["server", "levels", "output-format"]));
  const levels = optionalFlag(flags, "levels");
  const server = optionalFlag(flags, "server") ?? process.env.SEARCHGRES_URL;
  if (!server) throw new Error("--server or SEARCHGRES_URL is required");
  const client = createClient({
    transport: createFetchTransport({
      url: `${server.replace(/\/$/, "")}/rpc`,
    }),
  });
  const result = await client.treeView({
    ...(root ? { tree: root } : {}),
    ...(levels === undefined
      ? {}
      : { levels: nonnegativeInteger(levels, "levels") }),
  });
  const output = optionalFlag(flags, "output-format");
  if (output) return writeStructuredOutput(result, output);
  renderTree(result.entries, root);
}

function renderTree(
  entries: readonly { readonly tree: string; readonly count: number }[],
  root: string,
): void {
  const sorted = [...entries].sort((left, right) =>
    left.tree.localeCompare(right.tree),
  );
  const baseDepth = root === "" ? 0 : root.split(".").length;
  for (const [index, entry] of sorted.entries()) {
    const depth =
      entry.tree === "" ? 0 : entry.tree.split(".").length - baseDepth;
    const label =
      entry.tree === "" ? "." : (entry.tree.split(".").at(-1) ?? entry.tree);
    const branch = index === sorted.length - 1 ? "└──" : "├──";
    console.log(
      `${"│   ".repeat(Math.max(0, depth))}${branch} ${label} (${entry.count})`,
    );
  }
}

function remoteMethod(command: string): string | undefined {
  return {
    info: "searchgres.v1.server.info",
    upsert: "searchgres.v1.record.upsert",
    "upsert-many": "searchgres.v1.record.upsertMany",
    insert: "searchgres.v1.record.insert",
    "insert-many": "searchgres.v1.record.insertMany",
    get: "searchgres.v1.record.get",
    "get-by-name": "searchgres.v1.record.getByName",
    patch: "searchgres.v1.record.patch",
    delete: "searchgres.v1.record.delete",
    "delete-by-name": "searchgres.v1.record.deleteByName",
    move: "searchgres.v1.tree.move",
    copy: "searchgres.v1.tree.copy",
    deltree: "searchgres.v1.tree.delete",
    count: "searchgres.v1.tree.count",
    list: "searchgres.v1.tree.list",
    search: "searchgres.v1.search",
  }[command];
}

async function runRemote(
  command: string,
  flags: Map<string, string | true>,
): Promise<void> {
  rejectUnknownFlags(flags, allowedRemoteFlags(command));
  const server = optionalFlag(flags, "server") ?? process.env.SEARCHGRES_URL;
  if (!server) throw new Error("--server or SEARCHGRES_URL is required");
  const outputFormat = optionalFlag(flags, "output-format") ?? "json";
  const input = await readStructuredInput(
    command,
    optionalFlag(flags, "input"),
    optionalFlag(flags, "input-format"),
  );
  if (input !== undefined) {
    const fieldFlags = [...flags.keys()].filter(
      (name) =>
        !["server", "output-format", "input", "input-format"].includes(name),
    );
    if (fieldFlags.length > 0) {
      throw new Error(`--input cannot be combined with --${fieldFlags[0]}`);
    }
  }
  const params = input ?? paramsFromFlags(command, flags);
  const client = createClient({
    transport: createFetchTransport({
      url: `${server.replace(/\/$/, "")}/rpc`,
    }),
  });
  const result = await client.call(
    remoteMethod(command) as never,
    params as never,
  );
  writeStructuredOutput(result, outputFormat);
}

function allowedRemoteFlags(command: string): ReadonlySet<string> {
  const shared = ["server", "output-format", "input", "input-format"];
  const commandFlags: Record<string, readonly string[]> = {
    info: [],
    upsert: [],
    "upsert-many": [],
    insert: [],
    "insert-many": [],
    patch: [],
    get: ["id"],
    delete: ["id"],
    "get-by-name": ["tree", "name"],
    "delete-by-name": ["tree", "name"],
    move: ["source", "destination", "dry-run"],
    copy: ["source", "destination", "dry-run"],
    deltree: ["tree", "dry-run"],
    count: ["tree", "lquery", "ltxtquery", "limit"],
    list: ["lquery"],
    search: ["semantic", "fulltext", "tree", "limit"],
  };
  return new Set([...shared, ...(commandFlags[command] ?? [])]);
}

function paramsFromFlags(
  command: string,
  flags: Map<string, string | true>,
): unknown {
  const value = (name: string) => requiredFlag(flags, name);
  const dry = flags.has("dry-run") ? { options: { dryRun: true } } : {};
  if (command === "info") return undefined;
  if (command === "get" || command === "delete") return { id: value("id") };
  if (command === "get-by-name" || command === "delete-by-name")
    return { tree: value("tree"), name: value("name") };
  if (command === "move" || command === "copy")
    return {
      source: value("source"),
      destination: value("destination"),
      ...dry,
    };
  if (command === "deltree") return { tree: value("tree"), ...dry };
  if (command === "list") return { lquery: value("lquery") };
  if (command === "count") {
    const names = ["tree", "lquery", "ltxtquery"].filter((name) =>
      optionalFlag(flags, name),
    );
    if (names.length !== 1)
      throw new Error(
        "count requires exactly one of --tree, --lquery, or --ltxtquery",
      );
    const name = names[0]!;
    return {
      selector: { [name]: value(name) },
      ...(optionalFlag(flags, "limit")
        ? { limit: positiveInteger(value("limit"), "limit") }
        : {}),
    };
  }
  if (command === "search") {
    const semantic = optionalFlag(flags, "semantic");
    const fulltext = optionalFlag(flags, "fulltext");
    const tree = optionalFlag(flags, "tree");
    if (!semantic && !fulltext && !tree)
      throw new Error(
        "search requires --input, --semantic, --fulltext, or --tree",
      );
    return {
      ...(semantic ? { semantic } : {}),
      ...(fulltext ? { fulltext } : {}),
      ...(tree ? { filter: { tree } } : {}),
      ...(optionalFlag(flags, "limit")
        ? { limit: positiveInteger(value("limit"), "limit") }
        : {}),
    };
  }
  throw new Error(`${command} requires --input`);
}

async function readStructuredInput(
  command: string,
  input: string | undefined,
  format: string | undefined,
): Promise<unknown | undefined> {
  if (!input) return undefined;
  const source =
    input === "-"
      ? await Bun.stdin.text()
      : input.startsWith("@")
        ? await Bun.file(input.slice(1)).text()
        : input;
  const kind =
    format ??
    (input.endsWith(".json5")
      ? "json5"
      : input.endsWith(".yaml") || input.endsWith(".yml")
        ? "yaml"
        : "json");
  if (kind === "json") return JSON.parse(source);
  if (kind === "json5") return JSON5.parse(source);
  if (kind === "yaml") return YAML.parse(source);
  if (kind === "ndjson") {
    if (command !== "upsert-many" && command !== "insert-many") {
      throw new Error(
        "NDJSON input is supported only by upsert-many and insert-many",
      );
    }
    return {
      records: source
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line)),
    };
  }
  throw new Error("--input-format must be json, ndjson, json5, or yaml");
}
function writeStructuredOutput(value: unknown, format: string): void {
  if (format === "json") return void console.log(JSON.stringify(value));
  if (format === "json5")
    return void console.log(JSON5.stringify(value, null, 2));
  if (format === "yaml") return void console.log(YAML.stringify(value));
  if (format === "ndjson") {
    const collection =
      typeof value === "object" &&
      value !== null &&
      "results" in value &&
      Array.isArray(value.results)
        ? value.results
        : typeof value === "object" &&
            value !== null &&
            "entries" in value &&
            Array.isArray(value.entries)
          ? value.entries
          : [value];
    for (const entry of collection) console.log(JSON.stringify(entry));
    return;
  }
  throw new Error("--output-format must be json, ndjson, json5, or yaml");
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

async function writeDotenvExample(
  configPath: string,
  databaseUrlEnv: string,
  apiKeyEnv: string | undefined,
): Promise<void> {
  const directory = dirname(configPath);
  const example = join(directory, ".env.example");
  if (!(await Bun.file(example).exists())) {
    await Bun.write(
      example,
      `${databaseUrlEnv}=\n${apiKeyEnv ? `${apiKeyEnv}=\n` : ""}`,
    );
  }
  const gitignore = join(directory, ".gitignore");
  const current = (await Bun.file(gitignore).exists())
    ? await readFile(gitignore, "utf8")
    : "";
  if (!current.split(/\r?\n/).includes(".env")) {
    await Bun.write(
      gitignore,
      `${current}${current !== "" && !current.endsWith("\n") ? "\n" : ""}.env\n`,
    );
  }
}

async function loadDotenv(path: string): Promise<void> {
  if (!(await Bun.file(path).exists())) return;
  const source = await readFile(path, "utf8");
  for (const [lineNumber, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match)
      throw new Error(`${path}:${lineNumber + 1}: invalid .env assignment`);
    const name = match[1]!;
    let value = match[2]!;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

export function flagsFromOptions(
  options: Record<string, unknown>,
): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue;
    const flag = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    flags.set(flag, value === true ? true : String(value));
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
function nonnegativeInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`--${name} must be a nonnegative integer`);
  return number;
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
