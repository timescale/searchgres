// `sg`: the unprivileged client. It talks only to a searchgres server over
// JSON-RPC. Provisioning, database access, and provider credentials remain in
// the independent `sg-server` binary.
import {
  createClient,
  createFetchTransport,
  type SearchgresClient,
} from "@searchgres/client";
import type { Filter } from "@searchgres/protocol";
import { exportRecords, importRecords } from "./bulk.ts";
import { filterExpressionFromFlags } from "./filter-input.ts";
import {
  camelCase,
  enumeration,
  type Flags,
  flagsFromOptions,
  kebabCase,
  nonnegativeInteger,
  optionalFlag,
  parseJsonObject,
  positiveInteger,
  requiredFlag,
  unitInterval,
} from "./flags.ts";
import {
  hasExplicitOutputFormat,
  outputFormat,
  readStructuredFile,
  readStructuredInput,
  writeStructuredOutput,
} from "./format.ts";
import { parseSelectFields, projectSearchEnvelope } from "./selection.ts";

export { flagsFromOptions };

const usage = `Usage:
  sg <command> [options]

Run \`sg --help\` for the command list. Creating an index and running a server
live in a separate binary: see \`sg-server --help\`.
`;

export async function runCommand(
  command: string,
  flags: Flags,
  args: readonly string[] = [],
): Promise<void> {
  if (command === "server" || command === "init" || command === "destroy") {
    throw new Error(
      `\`sg ${command}\` lives in the sg-server binary: run \`sg-server ${command}\``,
    );
  }
  assertOutputFormatApplies(command, flags);
  const client = remoteClient(flags);
  switch (command) {
    case "info":
      return output(await client.info(), flags);
    case "create":
      return runCreate(client, flags);
    case "get":
      return runGet(client, flags, args);
    case "update":
      return runUpdate(client, flags, args);
    case "delete":
      return runDelete(client, flags, args);
    case "search":
      return runSearch(client, flags);
    case "import":
      return runImport(client, flags, args);
    case "export":
      return runExport(client, flags, args);
    case "tree":
      return runTree(client, flags, args);
    case "count":
      return output(
        await client.countTree(paramsFromFlags("count", flags) as never),
        flags,
      );
    case "list":
      return output(
        await client.listTree({ lquery: requiredFlag(flags, "lquery") }),
        flags,
      );
    case "move":
    case "copy":
      return runMoveOrCopy(client, command, flags, args);
    default:
      throw new Error(usage);
  }
}

async function runSearch(
  client: SearchgresClient,
  flags: Flags,
): Promise<void> {
  const rawSelect = optionalFlag(flags, "select");
  let select: ReturnType<typeof parseSelectFields> | undefined;
  if (rawSelect !== undefined) {
    try {
      select = parseSelectFields(rawSelect);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid --select: ${message}`);
    }
  }

  const result = await client.search(
    (await resolvedSearchParams(flags, true)) as never,
  );
  output(
    select === undefined ? result : projectSearchEnvelope(result, select),
    flags,
  );
}

function assertOutputFormatApplies(command: string, flags: Flags): void {
  if (!flags.has("ndjson")) return;
  if (!["search", "list", "tree"].includes(command)) {
    throw new Error("--ndjson applies only to search, list, and tree");
  }
}

function remoteClient(flags: Flags): SearchgresClient {
  const server = optionalFlag(flags, "server") ?? process.env.SEARCHGRES_URL;
  if (!server) throw new Error("--server or SEARCHGRES_URL is required");
  return createClient({
    transport: createFetchTransport({
      url: `${server.replace(/\/$/, "")}/rpc`,
    }),
  });
}

async function runCreate(
  client: SearchgresClient,
  flags: Flags,
): Promise<void> {
  const file = optionalFlag(flags, "file");
  const format = optionalFlag(flags, "format");
  if (format !== undefined && !["json", "json5", "yaml"].includes(format)) {
    throw new Error("create --format must be json, json5, or yaml");
  }
  if (file !== undefined) {
    const conflicting = [
      "content",
      "tree",
      "name",
      "meta",
      "temporal",
      "id",
      "replace",
      "ignore",
    ].find((name) => flags.has(name));
    if (conflicting !== undefined) {
      throw new Error(`--file cannot be combined with --${conflicting}`);
    }
    const record = await readStructuredFile(file, format);
    return outputCreated(
      client,
      await client.insert({ record: record as never }),
      flags,
    );
  }
  if (format !== undefined) throw new Error("--format requires --file");

  const content = optionalFlag(flags, "content");
  if (content === undefined) throw new Error("--content is required");
  const record = {
    content,
    ...(optionalFlag(flags, "tree") === undefined
      ? {}
      : { tree: optionalFlag(flags, "tree") }),
    ...(optionalFlag(flags, "name") === undefined
      ? {}
      : { name: optionalFlag(flags, "name") }),
    ...(optionalFlag(flags, "meta") === undefined
      ? {}
      : { meta: parseJsonObject(requiredFlag(flags, "meta"), "meta") }),
    ...(optionalFlag(flags, "temporal") === undefined
      ? {}
      : {
          temporal: parseTemporal(requiredFlag(flags, "temporal"), "temporal"),
        }),
    ...(optionalFlag(flags, "id") === undefined
      ? {}
      : { id: optionalFlag(flags, "id") }),
  };
  if (flags.has("replace") || flags.has("ignore")) {
    return outputCreated(
      client,
      await client.upsert({
        record,
        onConflict: flags.has("ignore") ? "ignore" : "replace",
      } as never),
      flags,
    );
  }
  return outputCreated(client, await client.insert({ record } as never), flags);
}

async function runGet(
  client: SearchgresClient,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  if (args.length === 1)
    return output(await client.get({ id: args[0] as string }), flags);
  if (args.length === 2) {
    return output(
      await client.getByName({
        tree: args[0] as string,
        name: args[1] as string,
      }),
      flags,
    );
  }
  throw new Error("get requires <id> or <tree> <name>");
}

async function runUpdate(
  client: SearchgresClient,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const id = args[0];
  if (id === undefined || args.length !== 1)
    throw new Error("update requires <id>");
  const inputFormat = optionalFlag(flags, "input-format");
  if (
    inputFormat !== undefined &&
    !["json", "json5", "yaml"].includes(inputFormat)
  ) {
    throw new Error("--input-format must be json, json5, or yaml");
  }
  const inputFlag = optionalFlag(flags, "input");
  if (inputFormat !== undefined && inputFlag === undefined) {
    throw new Error("--input-format requires --input");
  }
  const input = await readStructuredInput(inputFlag, inputFormat);
  const fieldNames = ["content", "tree", "name", "meta", "temporal"];
  if (input !== undefined) {
    const conflicting = fieldNames.find((name) => flags.has(name));
    if (conflicting !== undefined) {
      throw new Error(`--input cannot be combined with --${conflicting}`);
    }
  }
  const patch =
    input ??
    Object.fromEntries(
      fieldNames
        .filter((name) => flags.has(name))
        .map((name) => {
          const value = optionalFlag(flags, name);
          if (value === undefined)
            throw new Error(`--${name} requires a value`);
          if (name === "meta") return [name, parseJsonObject(value, name)];
          if (name === "temporal") {
            return [name, value === "" ? null : parseTemporal(value, name)];
          }
          if (name === "name") return [name, value === "" ? null : value];
          return [name, value];
        }),
    );
  return output(
    await client.patch({
      id,
      priorVersionHash: requiredFlag(flags, "version-hash"),
      patch: patch as never,
    }),
    flags,
  );
}

async function runDelete(
  client: SearchgresClient,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const tree = optionalFlag(flags, "tree");
  if (tree !== undefined) {
    if (args.length > 0)
      throw new Error("--tree cannot be combined with record addressing");
    if (!flags.has("dry-run") && !flags.has("yes")) {
      throw new Error("deleting a tree requires --yes (or use --dry-run)");
    }
    return output(
      await client.deleteTree({
        tree,
        ...(flags.has("dry-run") ? { options: { dryRun: true } } : {}),
      }),
      flags,
    );
  }
  if (flags.has("dry-run") || flags.has("yes")) {
    throw new Error("--dry-run and --yes apply only to --tree deletion");
  }
  if (args.length === 1)
    return output(await client.delete({ id: args[0] as string }), flags);
  if (args.length === 2) {
    return output(
      await client.deleteByName({
        tree: args[0] as string,
        name: args[1] as string,
      }),
      flags,
    );
  }
  throw new Error("delete requires <id>, <tree> <name>, or --tree <path>");
}

async function runImport(
  client: SearchgresClient,
  flags: Flags,
  files: readonly string[],
): Promise<void> {
  const summary = await importRecords(client, {
    files,
    format: optionalFlag(flags, "format"),
    recursive: flags.has("recursive"),
    defaultTree: optionalFlag(flags, "tree"),
    mode: flags.has("replace")
      ? "replace"
      : flags.has("ignore")
        ? "ignore"
        : "error",
    dryRun: flags.has("dry-run"),
    failFast: flags.has("fail-fast"),
    verbose: flags.has("verbose"),
  });
  output(summary, flags);
}

async function runExport(
  client: SearchgresClient,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  if (hasExplicitOutputFormat(flags)) {
    throw new Error(
      "export uses --format, not the global display-format flags",
    );
  }
  const format = optionalFlag(flags, "format") ?? "ndjson";
  if (!["ndjson", "json", "yaml", "md"].includes(format)) {
    throw new Error("--format must be ndjson, json, yaml, or md");
  }
  const rawLimit = optionalFlag(flags, "limit");
  const summary = await exportRecords(client, {
    file: args[0],
    format: format as "ndjson" | "json" | "yaml" | "md",
    limit: rawLimit === undefined ? 0 : nonnegativeInteger(rawLimit, "limit"),
    search: (await exportSearchParams(flags)) as never,
  });
  console.error(
    `exported ${summary.exported} record(s); ${summary.withoutEmbedding} without an embedding`,
  );
}

async function exportSearchParams(
  flags: Flags,
): Promise<Record<string, unknown>> {
  const withoutLimit = new Map(flags);
  withoutLimit.delete("limit");
  return resolvedSearchParams(withoutLimit, false);
}

async function outputCreated(
  client: SearchgresClient,
  write: { readonly result: { readonly id: string; readonly status: string } },
  flags: Flags,
): Promise<void> {
  const fetched = await client.get({ id: write.result.id });
  output({ result: write.result, record: fetched.record }, flags);
}

async function runTree(
  client: SearchgresClient,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const root = args[0] ?? "";
  const levels = optionalFlag(flags, "levels");
  const result = await client.treeView({
    ...(root ? { tree: root } : {}),
    ...(levels === undefined
      ? {}
      : { levels: nonnegativeInteger(levels, "levels") }),
  });
  if (hasExplicitOutputFormat(flags)) return output(result, flags);
  renderTree(result.entries, root);
}

async function runMoveOrCopy(
  client: SearchgresClient,
  command: "move" | "copy",
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const [source, destination] = args;
  if (source === undefined || destination === undefined || args.length !== 2) {
    throw new Error(`${command} requires <source> <destination>`);
  }
  const params = {
    source,
    destination,
    ...(flags.has("dry-run") ? { options: { dryRun: true } } : {}),
  };
  output(
    command === "move"
      ? await client.moveTree(params)
      : await client.copyTree(params),
    flags,
  );
}

function output(value: unknown, flags: Flags): void {
  writeStructuredOutput(value, outputFormat(flags));
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

/** Map search/count flags to RPC params; exported for fast unit tests. */
export function paramsFromFlags(command: string, flags: Flags): unknown {
  if (command === "count") {
    const names = ["tree", "lquery", "ltxtquery"].filter((name) =>
      flags.has(name),
    );
    const [name] = names;
    if (names.length !== 1 || name === undefined) {
      throw new Error(
        "count requires exactly one of --tree, --lquery, or --ltxtquery",
      );
    }
    const selector = optionalFlag(flags, name);
    if (selector === undefined) throw new Error(`--${name} requires a value`);
    return {
      selector: { [name]: selector },
      ...(optionalFlag(flags, "limit") === undefined
        ? {}
        : { limit: positiveInteger(requiredFlag(flags, "limit"), "limit") }),
    };
  }
  if (command === "search") {
    if (flags.has("filter") || flags.has("filter-file")) {
      throw new Error(
        "filter expressions require asynchronous input resolution",
      );
    }
    return searchParamsFromFlags(flags, true);
  }
  throw new Error(`cannot derive ${command} params from flags`);
}

async function resolvedSearchParams(
  flags: Flags,
  requireCriterion: boolean,
): Promise<Record<string, unknown>> {
  const expression = await filterExpressionFromFlags(flags);
  return searchParamsFromFlags(flags, requireCriterion, expression);
}

function searchParamsFromFlags(
  flags: Flags,
  requireCriterion: boolean,
  expression?: Filter,
): Record<string, unknown> {
  const semantic = optionalFlag(flags, "semantic");
  const fulltext = optionalFlag(flags, "fulltext");
  const leaves = filterLeavesFromFlags(flags);
  if (expression !== undefined && leaves.length > 0) {
    throw new Error(
      "--filter and --filter-file cannot be combined with flat filter flags",
    );
  }
  if (
    requireCriterion &&
    semantic === undefined &&
    fulltext === undefined &&
    leaves.length === 0 &&
    expression === undefined
  ) {
    throw new Error(
      "search requires a ranking flag (--semantic, --fulltext) or a filter flag",
    );
  }
  return {
    ...(semantic === undefined ? {} : { semantic }),
    ...(fulltext === undefined ? {} : { fulltext }),
    ...(expression !== undefined
      ? { filter: expression }
      : leaves.length === 0
        ? {}
        : { filter: conjoin(leaves) }),
    ...numericSearchOptions(flags),
    ...(optionalFlag(flags, "order") === undefined
      ? {}
      : {
          order: enumeration(requiredFlag(flags, "order"), "order", [
            "asc",
            "desc",
          ]),
        }),
    ...(optionalFlag(flags, "after") === undefined
      ? {}
      : { after: optionalFlag(flags, "after") }),
    ...(optionalFlag(flags, "before") === undefined
      ? {}
      : { before: optionalFlag(flags, "before") }),
  };
}

const filterLeafFlags = [
  { key: "tree", parse: (raw: string) => raw },
  { key: "lquery", parse: (raw: string) => raw },
  { key: "ltxtquery", parse: (raw: string) => raw },
  { key: "meta", parse: (raw: string) => parseJsonObject(raw, "meta") },
  { key: "metaPredicate", parse: (raw: string) => raw },
  {
    key: "temporalWithin",
    parse: (raw: string) => parseRange(raw, "temporal-within"),
  },
  {
    key: "temporalOverlaps",
    parse: (raw: string) => parseRange(raw, "temporal-overlaps"),
  },
  { key: "temporalBefore", parse: (raw: string) => raw },
  { key: "temporalAfter", parse: (raw: string) => raw },
  { key: "temporalContains", parse: (raw: string) => raw },
  { key: "regexp", parse: (raw: string) => raw },
] as const satisfies readonly {
  key: string;
  parse: (raw: string) => unknown;
}[];

export const flagNameFor = kebabCase;
export const filterFlagNames: readonly string[] = filterLeafFlags.map((leaf) =>
  flagNameFor(leaf.key),
);

function filterLeavesFromFlags(
  flags: Flags,
): readonly Record<string, unknown>[] {
  const leaves: Record<string, unknown>[] = [];
  for (const { key, parse } of filterLeafFlags) {
    const raw = optionalFlag(flags, flagNameFor(key));
    if (raw !== undefined) leaves.push({ [key]: parse(raw) });
  }
  return leaves;
}

function conjoin(
  leaves: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const [first] = leaves;
  if (first === undefined) throw new Error("expected at least one filter leaf");
  return leaves.length === 1 ? first : { and: [...leaves] };
}

function parseRange(raw: string, name: string): readonly [string, string] {
  const separator = raw.indexOf(",");
  if (separator === -1)
    throw new Error(`--${name} must be a "start,end" range`);
  const start = raw.slice(0, separator).trim();
  const end = raw.slice(separator + 1).trim();
  if (start === "" || end === "")
    throw new Error(`--${name} must be a "start,end" range`);
  return [start, end];
}

function parseTemporal(
  raw: string,
  name: string,
): readonly [string] | readonly [string, string] {
  return raw.includes(",") ? parseRange(raw, name) : [raw];
}

function numericSearchOptions(flags: Flags): Record<string, number> {
  const options: Record<string, number> = {};
  for (const name of ["limit", "candidate-limit"]) {
    const raw = optionalFlag(flags, name);
    if (raw !== undefined)
      options[camelCase(name)] = positiveInteger(raw, name);
  }
  for (const name of [
    "semantic-threshold",
    "semantic-weight",
    "fulltext-weight",
  ]) {
    const raw = optionalFlag(flags, name);
    if (raw !== undefined) options[camelCase(name)] = unitInterval(raw, name);
  }
  return options;
}
