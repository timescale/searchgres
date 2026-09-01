import { Command, Option } from "commander";
import { filterFlagNames, flagsFromOptions, runCommand } from "./cli.ts";

/** Commander owns command discovery, help, arguments, and shell-facing errors. */
export async function runProgram(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("sg")
    .description(
      "Searchgres client: records, trees, import/export, and search. Provisioning and serving live in sg-server.",
    )
    .showSuggestionAfterError()
    .configureHelp({ showGlobalOptions: true })
    .version("0.0.0")
    .option("--server <url>", "server URL; defaults to SEARCHGRES_URL")
    .addOption(
      new Option("--yaml", "emit YAML (the default)").conflicts([
        "json",
        "ndjson",
      ]),
    )
    .addOption(new Option("--json", "emit JSON").conflicts(["yaml", "ndjson"]))
    .addOption(
      new Option("--ndjson", "emit one JSON object per line").conflicts([
        "yaml",
        "json",
      ]),
    );

  action(
    program.command("info").description("show server capabilities"),
    "info",
  );

  const create = program
    .command("create")
    .description("create one record")
    .option("--content <text>", "record content")
    .option("--file <path>", "read one structured record; - reads stdin")
    .option("--format <format>", "file format: json, json5, or yaml")
    .option("--tree <path>", "raw dotted tree path")
    .option("--name <name>", "record name")
    .option("--meta <json>", "metadata as a JSON object")
    .option("--temporal <start[,end]>", "temporal instant or interval")
    .option("--id <uuid>", "explicit UUIDv7")
    .addOption(
      new Option("--replace", "replace a conflicting named record").conflicts(
        "ignore",
      ),
    )
    .addOption(
      new Option("--ignore", "keep a conflicting named record").conflicts(
        "replace",
      ),
    );
  action(create, "create");

  action(
    program
      .command("get")
      .description("get one record by id or by tree and name")
      .argument("<reference...>", "<id> or <tree> <name>"),
    "get",
  );

  const update = program
    .command("update")
    .description("update one record optimistically")
    .argument("<id>", "record UUIDv7")
    .requiredOption("--version-hash <hash>", "current record version hash")
    .option("--content <text>", "new content")
    .option("--tree <path>", "new raw dotted tree path")
    .option("--name <name>", "new name; an empty value clears it")
    .option("--meta <json>", "replacement metadata JSON object")
    .option("--temporal <start[,end]>", "new instant/interval; empty clears it")
    .option("--input <value>", "structured patch: inline, @file, or -")
    .option("--input-format <format>", "json, json5, or yaml");
  action(update, "update");

  const deletion = program
    .command("delete")
    .description("delete one record, or an inclusive subtree")
    .argument("[reference...]", "<id> or <tree> <name>")
    .option("--tree <path>", "delete this inclusive subtree")
    .option("--dry-run", "report subtree count without deleting")
    .option("--yes", "confirm subtree deletion");
  action(deletion, "delete");

  const search = program
    .command("search")
    .description("run filter, full-text, semantic, or hybrid search")
    .option("--semantic <text>", "semantic query text")
    .option("--fulltext <text>", "full-text query text");
  addFilterOptions(search);
  search
    .option("--limit <n>", "maximum result count")
    .option("--candidate-limit <n>", "per-arm candidate pool size")
    .option("--semantic-threshold <n>", "minimum cosine similarity in [0,1]")
    .option("--semantic-weight <n>", "semantic RRF weight in [0,1]")
    .option("--fulltext-weight <n>", "full-text RRF weight in [0,1]")
    .option(
      "--select <fields>",
      "comma-separated output fields, e.g. id,content:200,score",
    )
    .option("--order <direction>", "filter-only order: asc or desc")
    .option("--after <uuid>", "filter-only keyset cursor")
    .option("--before <uuid>", "reverse filter-only keyset cursor");
  action(search, "search");

  const importCommand = program
    .command("import")
    .description("import records from files, directories, or stdin")
    .argument("[files...]", "files/directories; - reads stdin")
    .option("-r, --recursive", "recursively import directories")
    .option("--format <format>", "force ndjson, json, yaml, or md")
    .option("--tree <path>", "default tree for records without one")
    .addOption(
      new Option("--replace", "replace conflicting named records").conflicts(
        "ignore",
      ),
    )
    .addOption(
      new Option("--ignore", "keep conflicting named records").conflicts(
        "replace",
      ),
    )
    .option("--dry-run", "parse and validate without writing")
    .option("--fail-fast", "stop on the first failed file or batch")
    .option("-v, --verbose", "print per-file progress to stderr");
  action(importCommand, "import");

  const exportCommand = program
    .command("export")
    .description("export filtered records to a file or stdout")
    .argument("[file]", "output file, or directory for Markdown")
    .option("--format <format>", "ndjson, json, yaml, or md", "ndjson");
  addFilterOptions(exportCommand);
  exportCommand.option("--limit <n>", "maximum records; 0 means all");
  action(exportCommand, "export");

  action(
    program
      .command("tree")
      .description("render a tree with descendant counts")
      .argument("[tree]", "root tree path")
      .option("--levels <n>", "maximum relative depth"),
    "tree",
  );
  action(
    program
      .command("count")
      .description("count records selected by a tree expression")
      .option("--tree <path>", "raw dotted tree path")
      .option("--lquery <query>", "ltree lquery")
      .option("--ltxtquery <query>", "ltree ltxtquery")
      .option("--limit <n>", "cap the count"),
    "count",
  );
  action(
    program
      .command("list")
      .description("list matching tree nodes with counts")
      .requiredOption("--lquery <query>", "ltree lquery"),
    "list",
  );
  action(
    program
      .command("move")
      .description("move a subtree")
      .argument("<source>", "source tree path")
      .argument("<destination>", "destination tree path")
      .option("--dry-run", "report count without changing records"),
    "move",
  );
  action(
    program
      .command("copy")
      .description("copy a subtree with fresh record ids")
      .argument("<source>", "source tree path")
      .argument("<destination>", "destination tree path")
      .option("--dry-run", "report count without changing records"),
    "copy",
  );

  const moved = new Set(["server", "serve", "init", "destroy"]);
  const [first] = argv;
  if (first !== undefined && moved.has(first)) {
    throw new Error(
      `\`sg ${first}\` lives in the sg-server binary: run \`sg-server ${first === "server" ? "serve" : first}\``,
    );
  }

  await program.parseAsync(["node", "sg", ...argv]);
}

function addFilterOptions(command: Command): void {
  command
    .option("--tree <path>", "records at or below a raw dotted tree path")
    .option("--lquery <query>", "ltree lquery")
    .option("--ltxtquery <query>", "ltree ltxtquery")
    .option("--meta <json>", "metadata containment as a JSON object")
    .option("--meta-predicate <jsonpath>", "JSONPath metadata predicate")
    .option("--temporal-within <start,end>", "record falls inside the window")
    .option("--temporal-overlaps <start,end>", "record overlaps the window")
    .option("--temporal-before <ts>", "record is strictly before this instant")
    .option("--temporal-after <ts>", "record is strictly after this instant")
    .option("--temporal-contains <ts>", "record contains this instant")
    .option(
      "--regexp <pattern>",
      "case-insensitive POSIX content regex; needs another filter",
    );

  // Keep this assertion adjacent to registration: adding a leaf in cli.ts
  // without giving Commander a matching option should fail immediately.
  const registered = new Set(
    command.options.map((option) => option.attributeName()),
  );
  for (const name of filterFlagNames) {
    const attribute = name.replace(/-([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (!registered.has(attribute))
      throw new Error(`missing --${name} registration`);
  }
}

function action(command: Command, name: string): void {
  command.action(async (...actionArgs: unknown[]) => {
    const invoked = actionArgs.at(-1) as Command;
    await runCommand(
      name,
      flagsFromOptions(invoked.optsWithGlobals()),
      invoked.args,
    );
  });
}
