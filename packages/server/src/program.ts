import { Command } from "commander";
import { runServerCommand } from "./cli.ts";
import { flagsFromOptions } from "./flags.ts";

/** Commander owns command discovery, help, and parse errors for `searchgres-server`. */
export async function runProgram(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("searchgres-server")
    .description("Searchgres server configuration, provisioning, and runtime")
    .showSuggestionAfterError();

  program
    .command("config")
    .description("generate a server config without connecting to PostgreSQL")
    .usage("[--config <path> --schema <schema> ...]")
    .option("--config <path>", "config file to write (.yaml, .yml, or .json5)")
    .option("--database-url-env <name>", "database URL environment variable")
    .option("--schema <name>", "index schema")
    .option("--embedding-model <model>", "embedding model")
    .option("--dimensions <n>", "embedding dimensions")
    .option("--vector-type <type>", "vector or halfvec")
    .option("--api-key-env <name>", "embedding API-key environment variable")
    .option("--base-url <url>", "OpenAI-compatible provider URL")
    .option("--host <host>", "listen host")
    .option("--port <port>", "listen port")
    .option(
      "--allow-public-listen",
      "acknowledge unauthenticated public listen",
    )
    .option("--tokenizer <preset>", "tokenizer preset")
    .option("--max-tokens <n>", "raw content token budget")
    .option("--dry-run", "print what would be written without writing it");

  addEnvironmentOptions(
    program
      .command("init")
      .description("initialize the configured index in PostgreSQL")
      .usage("--config <path> [--if-not-exists]")
      .option("--config <path>", "server configuration path")
      .option(
        "--if-not-exists",
        "accept an existing compatible Searchgres index",
      ),
  );

  addEnvironmentOptions(
    program
      .command("serve")
      .description("run the server")
      .usage("--config <path> [--read-only]")
      .option("--config <path>", "server configuration path")
      .option(
        "--read-only",
        "disable mutating RPC methods and the embedding worker",
      ),
  );

  addEnvironmentOptions(
    program
      .command("destroy")
      .description("drop the index this config points at")
      .usage("--config <path> --yes")
      .option("--config <path>", "server configuration path")
      .option("--yes", "confirm destructive action"),
  );

  for (const command of program.commands) {
    command.action(async (...actionArgs: unknown[]) => {
      const invoked = actionArgs.at(-1) as Command;
      const flags = flagsFromOptions(invoked.opts());
      restoreEnvironmentOptionHistory(flags, argv);
      await runServerCommand(invoked.name(), flags);
    });
  }

  await program.parseAsync(["node", "searchgres-server", ...argv]);
}

function addEnvironmentOptions(command: Command): Command {
  return command
    .option("--env-file <path>", "dotenv file")
    .option("--no-env-file", "do not load a dotenv file");
}

function restoreEnvironmentOptionHistory(
  flags: Map<string, string | true>,
  argv: readonly string[],
): void {
  // Commander maps both options to one `envFile` attribute, so if both are
  // supplied the later value hides the earlier one. Retain raw presence here
  // so the command layer can reject the conflict instead of silently choosing.
  for (const [index, argument] of argv.entries()) {
    if (argument === "--no-env-file") flags.set("no-env-file", true);
    if (argument === "--env-file") {
      const value = argv[index + 1];
      if (value !== undefined) flags.set("env-file", value);
    } else if (argument.startsWith("--env-file=")) {
      flags.set("env-file", argument.slice("--env-file=".length));
    }
  }
}
