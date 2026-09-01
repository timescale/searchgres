import { JSON5, YAML } from "bun";

export type InputFormat = "json" | "ndjson" | "json5" | "yaml" | "md";
export type OutputFormat = "json" | "ndjson" | "yaml";

/** Read inline text, `@file`, or `-` from stdin as one structured document. */
export async function readStructuredInput(
  input: string | undefined,
  format: string | undefined,
): Promise<unknown | undefined> {
  if (input === undefined) return undefined;
  const source =
    input === "-"
      ? await Bun.stdin.text()
      : input.startsWith("@")
        ? await Bun.file(input.slice(1)).text()
        : input;
  return parseStructured(source, inputFormat(format, input, source), false);
}

/** Read a path (or `-`) as one structured document. */
export async function readStructuredFile(
  path: string,
  format: string | undefined,
): Promise<unknown> {
  const source =
    path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  return parseStructured(source, inputFormat(format, path, source), false);
}

export function parseStructured(
  source: string,
  format: InputFormat,
  allowCollections: boolean,
): unknown {
  if (format === "json") return JSON.parse(source);
  if (format === "json5") return JSON5.parse(source);
  if (format === "yaml") return YAML.parse(source);
  if (format === "ndjson") {
    if (!allowCollections)
      throw new Error("NDJSON requires a collection input");
    return source
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  }
  if (format === "md") return parseMarkdownRecord(source);
  throw new Error(`unsupported input format: ${format satisfies never}`);
}

export function inputFormat(
  explicit: string | undefined,
  path: string,
  source?: string,
): InputFormat {
  if (explicit !== undefined) {
    if (["json", "ndjson", "json5", "yaml", "md"].includes(explicit)) {
      return explicit as InputFormat;
    }
    throw new Error("format must be json, ndjson, json5, yaml, or md");
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".json5")) return "json5";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  if (lower.endsWith(".json")) return "json";
  if (source !== undefined) return sniffInputFormat(source);
  return "json";
}

function sniffInputFormat(source: string): InputFormat {
  const trimmed = source.trim();
  if (trimmed.startsWith("---\n") || trimmed.startsWith("---\r\n")) {
    return "md";
  }
  try {
    JSON.parse(source);
    return "json";
  } catch {
    const lines = source.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length > 1) {
      try {
        for (const line of lines) JSON.parse(line);
        return "ndjson";
      } catch {
        // Fall through to YAML; a pretty-printed JSON document was already
        // attempted as a whole above.
      }
    }
    return "yaml";
  }
}

export function outputFormat(
  flags: ReadonlyMap<string, string | true>,
): OutputFormat {
  if (flags.has("json")) return "json";
  if (flags.has("ndjson")) return "ndjson";
  return "yaml";
}

export function hasExplicitOutputFormat(
  flags: ReadonlyMap<string, string | true>,
): boolean {
  return flags.has("yaml") || flags.has("json") || flags.has("ndjson");
}

export function writeStructuredOutput(
  value: unknown,
  format: OutputFormat,
): void {
  if (format === "json") return void console.log(JSON.stringify(value));
  if (format === "yaml")
    return void console.log(YAML.stringify(value).trimEnd());

  const collection = collectionFromEnvelope(value);
  for (const entry of collection) console.log(JSON.stringify(entry));
}

function collectionFromEnvelope(value: unknown): readonly unknown[] {
  if (typeof value === "object" && value !== null) {
    if ("results" in value && Array.isArray(value.results))
      return value.results;
    if ("entries" in value && Array.isArray(value.entries))
      return value.entries;
  }
  throw new Error("--ndjson applies only to commands that return a collection");
}

function parseMarkdownRecord(source: string): Record<string, unknown> {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { content: source };
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1)
    throw new Error("Markdown frontmatter is missing its closing ---");
  const parsed = YAML.parse(normalized.slice(4, end));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Markdown frontmatter must be a YAML object");
  }
  return {
    ...(parsed as Record<string, unknown>),
    content: normalized.slice(end + 5),
  };
}
