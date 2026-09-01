// `sg`: the unprivileged client. Talks to a searchgres server over JSON-RPC and
// nothing else.
//
// Provisioning and serving live in the separate `sg-server` binary
// (packages/server/src/cli.ts). The split is not cosmetic: `bun build --compile`
// initializes a binary's entire module graph at startup, executed or not, so
// anything reachable from here — postgres, the core library, the embedding
// provider, the prompt library — is paid by every `sg` invocation. Keeping them
// unreachable is what makes this binary fast.
import { createClient, createFetchTransport } from "@searchgres/client";
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
  rejectUnknownFlags,
  requiredFlag,
  unitInterval,
} from "./flags.ts";
import { readStructuredInput, writeStructuredOutput } from "./format.ts";

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
  // A clear pointer beats "unknown command" for anyone with the old habits.
  if (command === "server" || command === "init" || command === "destroy") {
    throw new Error(
      `\`sg ${command}\` lives in the sg-server binary: run \`sg-server ${command}\``,
    );
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
    optionalFlag(flags, "input"),
    optionalFlag(flags, "input-format"),
    command === "upsert-many" || command === "insert-many",
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
    search: [
      "semantic",
      "fulltext",
      ...filterFlagNames,
      "limit",
      "candidate-limit",
      "semantic-threshold",
      "semantic-weight",
      "fulltext-weight",
      "order",
    ],
  };
  return new Set([...shared, ...(commandFlags[command] ?? [])]);
}

/**
 * Map a command's flags to its RPC params. Exported for testing: this is pure
 * input-to-output, so the per-flag matrix belongs in a unit test rather than in
 * the compiled-binary suite, where each case would cost a process spawn.
 */
export function paramsFromFlags(
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
    const [name] = names;
    if (names.length !== 1 || name === undefined)
      throw new Error(
        "count requires exactly one of --tree, --lquery, or --ltxtquery",
      );
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
    const leaves = filterLeavesFromFlags(flags);
    if (!semantic && !fulltext && leaves.length === 0)
      throw new Error(
        "search requires --input, a ranking flag (--semantic, --fulltext), or a filter flag",
      );
    return {
      ...(semantic ? { semantic } : {}),
      ...(fulltext ? { fulltext } : {}),
      ...(leaves.length > 0 ? { filter: conjoin(leaves) } : {}),
      ...numericSearchOptions(flags),
      ...(optionalFlag(flags, "order")
        ? { order: enumeration(value("order"), "order", ["asc", "desc"]) }
        : {}),
    };
  }
  throw new Error(`${command} requires --input`);
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

/** `temporalWithin` -> `temporal-within`. */
export const flagNameFor = kebabCase;

/** Every filter leaf flag name, for option registration and flag validation. */
export const filterFlagNames: readonly string[] = filterLeafFlags.map((leaf) =>
  flagNameFor(leaf.key),
);

/** Collect the filter leaves the caller supplied, in declaration order. */
function filterLeavesFromFlags(
  flags: Map<string, string | true>,
): readonly Record<string, unknown>[] {
  const leaves: Record<string, unknown>[] = [];
  for (const { key, parse } of filterLeafFlags) {
    const raw = optionalFlag(flags, flagNameFor(key));
    if (raw === undefined) continue;
    leaves.push({ [key]: parse(raw) });
  }
  return leaves;
}

/**
 * AND the supplied leaves. A single leaf is passed through bare because the
 * filter schema requires `and` to hold at least two members.
 */
function conjoin(
  leaves: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const [first] = leaves;
  if (first === undefined) throw new Error("expected at least one filter leaf");
  return leaves.length === 1 ? first : { and: [...leaves] };
}

function parseRange(raw: string, name: string): readonly string[] {
  const separator = raw.indexOf(",");
  if (separator === -1)
    throw new Error(`--${name} must be a "start,end" range`);
  const start = raw.slice(0, separator).trim();
  const end = raw.slice(separator + 1).trim();
  if (start === "" || end === "")
    throw new Error(`--${name} must be a "start,end" range`);
  return [start, end];
}

/** The numeric ranking/paging knobs shared by ranked and filter-only search. */
function numericSearchOptions(
  flags: Map<string, string | true>,
): Record<string, number> {
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

/** `candidate-limit` -> `candidateLimit`. */
