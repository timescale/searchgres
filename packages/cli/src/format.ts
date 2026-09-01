import { JSON5, YAML } from "bun";

/** The input/output encodings both binaries accept on `--input`/`--output-format`. */
export type Format = "json" | "ndjson" | "json5" | "yaml";

/**
 * Read `--input`: inline text, `@file`, or `-` for stdin. The format is taken
 * from `--input-format`, else inferred from a file extension, else JSON.
 *
 * NDJSON is a collection encoding, so it is only meaningful for the bulk
 * commands; `allowNdjson` says whether the caller is one.
 */
export async function readStructuredInput(
  input: string | undefined,
  format: string | undefined,
  allowNdjson: boolean,
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
    if (!allowNdjson) {
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

export function writeStructuredOutput(value: unknown, format: string): void {
  if (format === "json") return void console.log(JSON.stringify(value));
  if (format === "json5")
    return void console.log(JSON5.stringify(value, null, 2));
  if (format === "yaml") return void console.log(YAML.stringify(value));
  if (format === "ndjson") {
    // NDJSON means one object per line, so unwrap the envelope's collection
    // when there is one; a single record prints as its own line.
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
