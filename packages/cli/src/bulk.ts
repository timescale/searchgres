import { mkdir, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { SearchgresClient } from "@searchgres/client";
import {
  type RecordInput,
  recordInputSchema,
  type SearchParams,
} from "@searchgres/protocol";
import { YAML } from "bun";
import { inputFormat, parseStructured } from "./format.ts";

const MAX_BATCH_RECORDS = 1000;
const REQUEST_BUDGET_RATIO = 0.75;
const importExtensions = new Set([
  ".ndjson",
  ".jsonl",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".markdown",
]);

type ImportMode = "error" | "replace" | "ignore";

export interface ImportOptions {
  readonly files: readonly string[];
  readonly format?: string | undefined;
  readonly recursive: boolean;
  readonly defaultTree?: string | undefined;
  readonly mode: ImportMode;
  readonly dryRun: boolean;
  readonly failFast: boolean;
  readonly verbose: boolean;
}

export interface ImportSummary {
  readonly read: number;
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function importRecords(
  client: SearchgresClient,
  options: ImportOptions,
): Promise<ImportSummary> {
  const paths = await collectInputPaths(
    options.files.length === 0 ? ["-"] : options.files,
    options.recursive,
  );
  const records: RecordInput[] = [];
  let failed = 0;

  for (const path of paths) {
    try {
      const parsed = await parseImportPath(path, options.format);
      for (const candidate of parsed) {
        const withDefaultTree =
          options.defaultTree !== undefined && !("tree" in candidate)
            ? { ...candidate, tree: options.defaultTree }
            : candidate;
        const validated = recordInputSchema.safeParse(withDefaultTree);
        if (!validated.success) {
          throw new Error(
            `invalid record: ${validated.error.issues.map((issue) => issue.message).join("; ")}`,
          );
        }
        records.push(validated.data);
      }
      if (options.verbose) console.error(`${path}: ${parsed.length} record(s)`);
    } catch (error) {
      failed += 1;
      console.error(`${path}: ${errorMessage(error)}`);
      if (options.failFast) throw error;
    }
  }

  if (options.dryRun) {
    return {
      read: records.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed,
    };
  }

  const info = await client.info();
  const byteBudget = Math.floor(
    info.maxRequestBodyBytes * REQUEST_BUDGET_RATIO,
  );
  const batches = chunkRecordsForRequest(records, byteBudget, options.mode);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const batch of batches) {
    try {
      const result =
        options.mode === "error"
          ? await client.insertMany({ records: [...batch] })
          : await client.upsertMany({
              records: [...batch],
              onConflict: options.mode,
            });
      for (const item of result.results) {
        if (item.status === "inserted") inserted += 1;
        else if (item.status === "updated") updated += 1;
        else skipped += 1;
      }
    } catch (error) {
      failed += batch.length;
      console.error(`batch of ${batch.length}: ${errorMessage(error)}`);
      if (options.failFast) throw error;
    }
  }

  return { read: records.length, inserted, updated, skipped, failed };
}

export function chunkRecordsForRequest(
  records: readonly RecordInput[],
  byteBudget: number,
  mode: ImportMode,
): readonly (readonly RecordInput[])[] {
  const batches: RecordInput[][] = [];
  let batch: RecordInput[] = [];
  let bytes = envelopeBytes([], mode);

  for (const record of records) {
    const recordBytes =
      utf8Bytes(JSON.stringify(record)) + (batch.length > 0 ? 1 : 0);
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BATCH_RECORDS || bytes + recordBytes > byteBudget)
    ) {
      batches.push(batch);
      batch = [];
      bytes = envelopeBytes([], mode);
    }
    batch.push(record);
    bytes += recordBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function envelopeBytes(
  records: readonly RecordInput[],
  mode: ImportMode,
): number {
  const method =
    mode === "error"
      ? "searchgres.v1.record.insertMany"
      : "searchgres.v1.record.upsertMany";
  return utf8Bytes(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "999999999",
      method,
      params: mode === "error" ? { records } : { records, onConflict: mode },
    }),
  );
}

async function collectInputPaths(
  inputs: readonly string[],
  recursive: boolean,
): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const input of inputs) {
    if (input === "-") {
      paths.push(input);
      continue;
    }
    const absolute = resolve(input);
    const details = await stat(absolute).catch(() => undefined);
    if (!details) throw new Error(`File not found: ${input}`);
    if (details.isFile()) {
      paths.push(absolute);
      continue;
    }
    if (!details.isDirectory())
      throw new Error(`Not a file or directory: ${input}`);
    if (!recursive) {
      throw new Error(
        `'${input}' is a directory. Use --recursive to import directories.`,
      );
    }
    paths.push(...(await collectDirectory(absolute)));
  }
  return paths.toSorted();
}

async function collectDirectory(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await collectDirectory(path)));
    else if (
      entry.isFile() &&
      importExtensions.has(extname(entry.name).toLowerCase())
    ) {
      found.push(path);
    }
  }
  return found;
}

async function parseImportPath(
  path: string,
  explicitFormat: string | undefined,
): Promise<readonly Record<string, unknown>[]> {
  if (explicitFormat === "json5") {
    throw new Error("import --format must be ndjson, json, yaml, or md");
  }
  const source =
    path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  const format = inputFormat(explicitFormat, path, source);
  const parsed = parseStructured(source, format, true);
  if (format === "md") return [asRecord(parsed)];
  if (Array.isArray(parsed)) return parsed.map(asRecord);
  const object = asRecord(parsed);
  if (Array.isArray(object.records)) return object.records.map(asRecord);
  return [object];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected a record object or an array of record objects");
  }
  return value as Record<string, unknown>;
}

export interface ExportOptions {
  readonly file?: string | undefined;
  readonly format: "ndjson" | "json" | "yaml" | "md";
  readonly limit: number;
  readonly search: SearchParams;
}

export interface ExportSummary {
  readonly exported: number;
  readonly withoutEmbedding: number;
}

export async function exportRecords(
  client: SearchgresClient,
  options: ExportOptions,
): Promise<ExportSummary> {
  if (options.format === "md" && options.file === undefined) {
    throw new Error("Markdown export requires an output directory");
  }
  const writer = await createExportWriter(options.file, options.format);
  let exported = 0;
  let withoutEmbedding = 0;
  let after: string | undefined;

  try {
    while (options.limit === 0 || exported < options.limit) {
      const remaining = options.limit === 0 ? 1000 : options.limit - exported;
      const pageSize = Math.min(1000, remaining);
      const page = await client.search({
        ...options.search,
        order: "asc",
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      });
      for (const result of page.results) {
        await writer.write(exportableRecord(result));
        exported += 1;
        if (!result.hasEmbedding) withoutEmbedding += 1;
      }
      const last = page.results.at(-1);
      if (last === undefined || page.results.length < pageSize) break;
      after = last.id;
    }
  } finally {
    await writer.close();
  }

  return { exported, withoutEmbedding };
}

function exportableRecord(record: {
  readonly id: string;
  readonly content: string;
  readonly meta: NonNullable<RecordInput["meta"]>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
}): RecordInput {
  return {
    id: record.id,
    content: record.content,
    meta: record.meta,
    tree: record.tree,
    ...(record.temporal === null
      ? {}
      : { temporal: parsePostgresRange(record.temporal) }),
    name: record.name,
  };
}

interface ExportWriter {
  write(record: RecordInput): Promise<void>;
  close(): Promise<void>;
}

async function createExportWriter(
  file: string | undefined,
  format: ExportOptions["format"],
): Promise<ExportWriter> {
  if (format === "md") {
    const directory = resolve(file as string);
    await mkdir(directory, { recursive: true });
    return {
      async write(record) {
        await Bun.write(
          join(directory, `${record.id}.md`),
          markdownRecord(record),
        );
      },
      async close() {},
    };
  }

  if (file !== undefined) await Bun.write(file, "");
  const sink =
    file === undefined ? Bun.stdout.writer() : Bun.file(file).writer();
  let count = 0;
  if (format === "json") sink.write("[");

  return {
    async write(record) {
      if (format === "ndjson") sink.write(`${JSON.stringify(record)}\n`);
      else if (format === "json") {
        sink.write(
          `${count === 0 ? "\n" : ",\n"}${JSON.stringify(record, null, 2)}`,
        );
      } else {
        // Concatenating one-element YAML sequences yields one valid sequence
        // without retaining earlier records.
        sink.write(YAML.stringify([record]));
      }
      count += 1;
    },
    async close() {
      if (format === "json") sink.write(`${count === 0 ? "" : "\n"}]\n`);
      else if (format === "yaml" && count === 0) sink.write("[]\n");
      await sink.flush();
      if (file !== undefined) await sink.end();
    },
  };
}

function markdownRecord(record: RecordInput): string {
  const { content, ...frontmatter } = record;
  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${content}`;
}

/** Convert the canonical tstzrange text returned by PostgreSQL into input form. */
function parsePostgresRange(value: string): [string] | [string, string] {
  const match = /^[[(]"?(.+?)"?,"?(.+?)"?[)\]]$/.exec(value);
  if (!match?.[1] || !match[2])
    throw new Error(`cannot export temporal range: ${value}`);
  const start = exportTimestamp(match[1]);
  const end = exportTimestamp(match[2]);
  return start === end ? [start] : [start, end];
}

function exportTimestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`cannot export temporal timestamp: ${value}`);
  }
  return new Date(milliseconds).toISOString();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
