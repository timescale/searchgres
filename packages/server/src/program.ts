import { Command } from "commander";
import { runServerCommand } from "./cli.ts";
import { flagsFromOptions } from "./flags.ts";

/**
 * Commander owns command discovery, help, and parse errors for `sg-server`.
 * Only the three privileged commands live here; everything else is `sg`.
 */
export async function runProgram(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("sg-server")
    .description("Searchgres index provisioning and server")
    .showSuggestionAfterError();

  program
    .command("init")
    .description("create an index and write a server config")
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

  program
    .command("serve")
    .description("run the server")
    .usage("--config <path> [--read-only]")
    .option("--config <path>", "server configuration path")
    .option("--env-file <path>", "dotenv file")
    .option("--no-env-file", "do not load a dotenv file")
    .option(
      "--read-only",
      "disable mutating RPC methods and the embedding worker",
    );

  program
    .command("destroy")
    .description("drop the index this config points at")
    .usage("--config <path> --yes")
    .option("--config <path>", "server configuration path")
    .option("--yes", "confirm destructive action");

  for (const command of program.commands) {
    command.action(async (...actionArgs: unknown[]) => {
      const invoked = actionArgs.at(-1) as Command;
      await runServerCommand(invoked.name(), flagsFromOptions(invoked.opts()));
    });
  }

  await program.parseAsync(["node", "sg-server", ...argv]);
}
