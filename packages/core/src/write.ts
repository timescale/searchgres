import type postgres from "postgres";
import { z } from "zod";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  InvalidConfigError,
  SearchgresError,
  type ValidationIssue,
} from "./errors.ts";
import type { Index } from "./open-index.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import {
  normalizeTimestamp,
  timestampMilliseconds,
  timestampSchema,
} from "./temporal.ts";

const MAX_UPSERT_BATCH_SIZE = 1000;

const temporalSchema = z
  .union([
    z.tuple([timestampSchema]).readonly(),
    z.tuple([timestampSchema, timestampSchema]).readonly(),
  ])
  .superRefine((temporal, context) => {
    if (
      temporal.length === 2 &&
      timestampMilliseconds(temporal[0]) >= timestampMilliseconds(temporal[1])
    ) {
      context.addIssue({
        code: "custom",
        message: "interval start must be before its end",
      });
    }
  });

const recordSchema = z
  .object({
    id: z.uuidv7().optional(),
    content: z.string(),
    meta: z.object({}).catchall(z.json()).default({}),
    tree: z
      .string()
      .refine(
        (path) =>
          path === "" ||
          path.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label)),
        "expected dot-separated ltree labels matching [A-Za-z0-9_-]+ (or an empty string for the root)",
      )
      .default(""),
    temporal: temporalSchema.optional(),
    name: z.string().nullable().default(null),
    embedding: z.array(z.number().finite()).readonly().optional(),
  })
  .strict();

const upsertOptionsSchema = z
  .object({
    onConflict: z.enum(["error", "ignore", "replace"]).default("error"),
  })
  .strict()
  .default({ onConflict: "error" });

/** One record to insert or replace. */
export type UpsertRecord = z.input<typeof recordSchema>;
/** Conflict behavior for {@link Index.upsert} and {@link Index.upsertMany}. */
export type UpsertOptions = z.input<typeof upsertOptionsSchema>;
/** The outcome for one input record. */
export interface UpsertResult {
  readonly id: string;
  readonly status: "inserted" | "updated" | "skipped";
}

interface BatchUpsertRow {
  readonly ord: string;
  readonly id: string | null;
  readonly status: "inserted" | "updated" | "skipped";
}

/**
 * Validate a batch of records and write them through the schema-local
 * `batch_upsert` routine, which owns the full conflict contract in one call.
 */
export async function upsertMany(
  index: Index,
  records: readonly UpsertRecord[],
  options?: UpsertOptions,
): Promise<readonly UpsertResult[]> {
  if (records.length > MAX_UPSERT_BATCH_SIZE) {
    throw new BatchTooLargeError(records.length, MAX_UPSERT_BATCH_SIZE);
  }

  const parsedOptions = parseOptions(options);
  const ids: Array<string | null> = [];
  const contents: string[] = [];
  const metas: Array<z.output<typeof recordSchema>["meta"]> = [];
  const trees: string[] = [];
  const temporals: Array<string | null> = [];
  const names: Array<string | null> = [];
  const embeddings: Array<string | null> = [];
  const explicitIds = new Set<string>();
  const namedKeys = new Set<string>();

  for (let position = 0; position < records.length; position++) {
    const parsed = recordSchema.safeParse(records[position]);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const mapped = issue
        ? toValidationIssue(issue)
        : { code: "custom", message: "validation failed", path: [] };
      throwInvalidRecordInput(
        [{ ...mapped, path: [position, ...mapped.path] }],
        parsed.error,
      );
    }

    const record = parsed.data;
    if (record.embedding && record.embedding.length !== index.dimensions) {
      throw new DimensionMismatchError(
        index.dimensions,
        record.embedding.length,
        { position },
      );
    }
    const id = record.id ?? null;
    const name = record.name;
    // Fail fast before the round trip. `batch_upsert` enforces both rules too and
    // is authoritative (its body is part of the immutable schema format), so keep
    // these checks in sync with it rather than treating either side as the truth.
    if (id !== null) {
      // PostgreSQL `uuid` equality is case-insensitive, so compare on the
      // lowercased form; `ids` keeps the caller's spelling for the write.
      const key = id.toLowerCase();
      if (explicitIds.has(key)) {
        throw duplicateKeyError("duplicate explicit id within batch", position);
      }
      explicitIds.add(key);
    }
    if (name !== null) {
      const key = `${record.tree}\0${name}`;
      if (namedKeys.has(key)) {
        throw duplicateKeyError(
          "duplicate (tree, name) within batch",
          position,
        );
      }
      namedKeys.add(key);
    }

    ids.push(id);
    contents.push(record.content);
    metas.push(record.meta);
    trees.push(record.tree);
    temporals.push(normalizeTemporal(record.temporal));
    names.push(name);
    embeddings.push(encodeEmbedding(record.embedding));
  }
  if (ids.length === 0) return [];

  const { sql } = index;
  const rows = await runBatchUpsert(
    sql<BatchUpsertRow[]>`
      select ord, id, status
      from ${sql(index.schema)}.batch_upsert
      ( ${ids}
      , ${contents}
      , ${sql.json(metas)}
      , ${trees}
      , ${temporals}
      , ${names}
      , ${embeddings}
      , ${parsedOptions.onConflict}
      )
    `,
    index.schema,
  );

  // `ord` mirrors the routine's 1-based `with ordinality` position, so each
  // outcome lands on its input index instead of relying on the row order.
  const results = new Array<UpsertResult>(records.length);
  let resolved = 0;
  for (const row of rows) {
    if (!row.id) {
      throw new ConflictError(
        "A conflicting named record disappeared before its result could be resolved",
      );
    }
    const position = Number(row.ord) - 1;
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position >= results.length ||
      results[position] !== undefined
    ) {
      throw new Error(
        `Upsert result invariant failed: unexpected position ${row.ord}`,
      );
    }
    results[position] = { id: row.id, status: row.status };
    resolved++;
  }
  if (resolved !== results.length) {
    throw new Error(
      `Upsert result invariant failed: expected ${results.length} results, received ${resolved}`,
    );
  }
  return results;
}

async function runBatchUpsert(
  query: postgres.PendingQuery<BatchUpsertRow[]>,
  schema: string,
): Promise<readonly BatchUpsertRow[]> {
  try {
    return await runSql(query, {
      spanName: "batchUpsert",
      dbOperationName: "SELECT",
      namespace: schema,
    });
  } catch (error) {
    // `runSql` already mapped the context-free SQLSTATEs to typed errors; those
    // carry a searchgres `code`, so never re-inspect them as a SQLSTATE.
    if (error instanceof SearchgresError) {
      throw error;
    }
    const code = postgresErrorCode(error);
    if (code === "23505") {
      throw new ConflictError(
        "One or more records conflict with existing records",
        { cause: error },
      );
    }
    if (code === "22023") {
      throw new InvalidConfigError("Invalid record input", { cause: error });
    }
    throw error;
  }
}

function parseOptions(
  options: UpsertOptions | undefined,
): z.output<typeof upsertOptionsSchema> {
  const result = upsertOptionsSchema.safeParse(options);
  if (!result.success) {
    const [issue] = result.error.issues;
    const mapped = issue
      ? toValidationIssue(issue)
      : { code: "custom", message: "validation failed", path: [] };
    throwInvalidRecordInput([mapped], result.error);
  }
  return result.data;
}

function throwInvalidRecordInput(
  issues: readonly ValidationIssue[],
  cause?: z.ZodError,
): never {
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "record"}: ${first.message}`
    : "validation failed";
  throw new InvalidConfigError(`Invalid record input: ${detail}`, {
    cause,
    issues,
  });
}

function toValidationIssue(issue: z.core.$ZodIssue): ValidationIssue {
  return {
    code: issue.code,
    message: issue.message,
    path: issue.path.map((component) =>
      typeof component === "symbol" ? component.toString() : component,
    ),
  };
}

function duplicateKeyError(
  message: string,
  position: number,
): InvalidConfigError {
  return new InvalidConfigError(
    `Invalid record input: ${position}: ${message}`,
    {
      issues: [{ code: "custom", message, path: [position] }],
    },
  );
}

function normalizeTemporal(
  temporal: z.output<typeof temporalSchema> | undefined,
): string | null {
  if (!temporal) {
    return null;
  }
  const start = normalizeTimestamp(temporal[0]);
  if (temporal.length === 1) {
    return `[${start},${start}]`;
  }
  const end = normalizeTimestamp(temporal[1]);
  return `[${start},${end})`;
}

function encodeEmbedding(
  embedding: readonly number[] | undefined,
): string | null {
  return embedding === undefined ? null : JSON.stringify(embedding);
}
