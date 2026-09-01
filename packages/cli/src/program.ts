import { Command } from "commander";
import { filterFlagNames, flagsFromOptions, runCommand } from "./cli.ts";

/** `temporal-within` -> `temporalWithin`, matching Commander's attribute names. */
function camelCaseFlag(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Commander owns command discovery, help, and shell-facing parse errors.
 * The command handlers delegate to the existing typed CLI implementation while
 * its transport/input parsing is progressively moved out of cli.ts. */
export async function runProgram(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("sg")
    .description("Searchgres server, provisioning, and remote client CLI")
    .showSuggestionAfterError();

  register(
    program,
    "server",
    "start the one-index Searchgres server",
    "--config <path> [--read-only]",
  );
  register(
    program,
    "init",
    "create an index and write server configuration",
    "[options]",
  );
  register(
    program,
    "destroy",
    "destroy the configured index",
    "--config <path> --yes",
  );
  register(program, "info", "show server capabilities", "[--server <url>]");
  register(program, "upsert", "upsert one record", "--input <value>");
  register(program, "upsert-many", "upsert records", "--input <value>");
  register(program, "insert", "insert one record", "--input <value>");
  register(program, "insert-many", "insert records", "--input <value>");
  register(program, "get", "get a record by id", "--id <uuid>");
  register(
    program,
    "get-by-name",
    "get a record by tree and name",
    "--tree <path> --name <name>",
  );
  register(
    program,
    "patch",
    "patch a record optimistically",
    "--input <value>",
  );
  register(program, "delete", "delete a record by id", "--id <uuid>");
  register(
    program,
    "delete-by-name",
    "delete a record by tree and name",
    "--tree <path> --name <name>",
  );
  register(
    program,
    "move",
    "move a tree",
    "--source <path> --destination <path>",
  );
  register(
    program,
    "copy",
    "copy a tree",
    "--source <path> --destination <path>",
  );
  register(program, "deltree", "delete a tree", "--tree <path>");
  register(
    program,
    "count",
    "count tree records",
    "(--tree <path>|--lquery <query>|--ltxtquery <query>)",
  );
  register(program, "list", "list tree entries", "--lquery <query>");
  register(
    program,
    "tree",
    "render a tree with descendant counts",
    "[tree] [--levels <n>]",
  );
  register(
    program,
    "search",
    "run filter, full-text, semantic, or hybrid search",
    "[options]",
  );

  await program.parseAsync(["node", "sg", ...argv]);
}

function register(
  program: Command,
  name: string,
  description: string,
  usage: string,
): void {
  const command = program
    .command(name)
    .usage(usage)
    .description(description)
    .option("--server <url>", "server URL; defaults to SEARCHGRES_URL")
    .option(
      "--input <value>",
      "structured params: inline, @file, or - for stdin",
    )
    .option("--input-format <format>", "json, ndjson, json5, or yaml")
    .option("--output-format <format>", "json, ndjson, json5, or yaml")
    .option("--id <uuid>", "record UUIDv7")
    .option("--tree <path>", "raw dotted tree path")
    .option("--name <name>", "record name")
    .option("--source <path>", "source tree path")
    .option("--destination <path>", "destination tree path")
    .option("--dry-run", "preview a mutation without changing records")
    .option("--lquery <query>", "ltree lquery")
    .option("--ltxtquery <query>", "ltree ltxtquery")
    .option("--levels <n>", "maximum relative tree depth")
    .option("--limit <n>", "maximum result count")
    .option("--semantic <text>", "semantic query text")
    .option("--fulltext <text>", "full-text query text")
    // Filter leaves. Supplying several ANDs them together; each is also a
    // filter-only search on its own.
    .option("--meta <json>", "metadata filter as a JSON object")
    .option(
      "--meta-predicate <jsonpath>",
      "JSONPath predicate evaluated against metadata",
    )
    .option("--temporal-within <start,end>", "record falls inside the window")
    .option("--temporal-overlaps <start,end>", "record overlaps the window")
    .option("--temporal-before <ts>", "record is strictly before this instant")
    .option("--temporal-after <ts>", "record is strictly after this instant")
    .option("--temporal-contains <ts>", "record contains this instant")
    .option(
      "--regexp <pattern>",
      "case-insensitive POSIX regex on content; needs another filter",
    )
    .option("--candidate-limit <n>", "per-arm candidate pool size")
    .option(
      "--semantic-threshold <n>",
      "minimum cosine similarity in [0,1]; higher is stricter",
    )
    .option("--semantic-weight <n>", "semantic RRF weight in [0,1]")
    .option("--fulltext-weight <n>", "full-text RRF weight in [0,1]")
    .option("--order <direction>", "filter-only search: asc or desc")
    .option("--config <path>", "server configuration path")
    .option("--env-file <path>", "dotenv file")
    .option("--no-env-file", "do not load a dotenv file")
    .option(
      "--read-only",
      "disable mutating RPC methods and the embedding worker",
    )
    .option("--yes", "confirm destructive action")
    .option("--database-url-env <name>", "database URL environment variable")
    .option("--schema <name>", "index schema")
    .option("--embedding-model <model>", "embedding model")
    .option("--dimensions <n>", "embedding dimensions")
    .option("--host <host>", "listen host")
    .option("--port <port>", "listen port")
    .option(
      "--allow-public-listen",
      "acknowledge unauthenticated public listen",
    )
    .option("--vector-type <type>", "vector or halfvec")
    .option("--api-key-env <name>", "embedding API-key environment variable")
    .option("--base-url <url>", "OpenAI-compatible provider URL")
    .option("--tokenizer <preset>", "tokenizer preset")
    .option("--max-tokens <n>", "raw content token budget");

  if (name === "tree") command.argument("[tree]", "root tree path");
  hideIrrelevantOptions(command, name);
  command.action(async (...actionArgs: unknown[]) => {
    const command = actionArgs.at(-1) as Command;
    await runCommand(name, flagsFromOptions(command.opts()), command.args);
  });
}

function hideIrrelevantOptions(command: Command, name: string): void {
  const shared = new Set(["server", "input", "inputFormat", "outputFormat"]);
  const specific: Record<string, readonly string[]> = {
    server: ["config", "envFile", "noEnvFile", "readOnly"],
    init: [
      "config",
      "databaseUrlEnv",
      "schema",
      "embeddingModel",
      "dimensions",
      "host",
      "port",
      "allowPublicListen",
      "vectorType",
      "apiKeyEnv",
      "baseUrl",
      "tokenizer",
      "maxTokens",
      "dryRun",
    ],
    destroy: ["config", "yes"],
    info: [],
    get: ["id"],
    delete: ["id"],
    "get-by-name": ["tree", "name"],
    "delete-by-name": ["tree", "name"],
    move: ["source", "destination", "dryRun"],
    copy: ["source", "destination", "dryRun"],
    deltree: ["tree", "dryRun"],
    count: ["tree", "lquery", "ltxtquery", "limit"],
    list: ["lquery"],
    tree: ["levels"],
    search: [
      "semantic",
      "fulltext",
      ...filterFlagNames.map(camelCaseFlag),
      "limit",
      "candidateLimit",
      "semanticThreshold",
      "semanticWeight",
      "fulltextWeight",
      "order",
    ],
    upsert: [],
    "upsert-many": [],
    insert: [],
    "insert-many": [],
    patch: [],
  };
  const allowed = new Set([...shared, ...(specific[name] ?? [])]);
  for (const option of command.options) {
    if (!allowed.has(option.attributeName())) option.hideHelp();
  }
}
