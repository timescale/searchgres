import type postgres from "postgres";
import { z } from "zod";
import {
  ConflictError,
  DimensionMismatchError,
  InvalidConfigError,
  NotFoundError,
  SearchgresError,
  StaleVersionError,
  type ValidationIssue,
} from "./errors.ts";
import { assertTreePath, isValidTreePath } from "./identifiers.ts";
import type { Index } from "./open-index.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import { normalizeTemporalTuple, temporalTupleSchema } from "./temporal.ts";

/** A full record read back from the index. */
export interface StoredRecord {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly hasEmbedding: boolean;
  readonly version: string;
  readonly versionHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

interface RecordRow {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly has_embedding: boolean;
  readonly version: string;
  readonly version_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface PatchRow extends RecordRow {
  readonly found: boolean;
  readonly updated: boolean;
}

const idSchema = z.uuidv7();

const patchSchema = z
  .object({
    content: z.string().optional(),
    meta: z.record(z.string(), z.json()).optional(),
    tree: z
      .string()
      .refine(
        isValidTreePath,
        "expected a dotted ltree path (or the empty root)",
      )
      .optional(),
    name: z.string().nullable().optional(),
    temporal: temporalTupleSchema.nullable().optional(),
    embedding: z.array(z.number().finite()).readonly().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "patch must set at least one field",
  );

/** Fields a {@link Index.patch} may change. Omit a key to leave it unchanged. */
export type PatchInput = z.input<typeof patchSchema>;

export async function get(index: Index, id: string): Promise<StoredRecord> {
  const recordId = parseId(id);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<RecordRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.get_record(${recordId})
    `,
    index.schema,
    "getRecord",
  );
  if (!row) {
    throw new NotFoundError(recordId);
  }
  return mapRecord(row);
}

export async function getByName(
  index: Index,
  tree: string,
  name: string,
): Promise<StoredRecord> {
  const treePath = assertTreePath(tree);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<RecordRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.get_record_by_name(${treePath}, ${name})
    `,
    index.schema,
    "getRecordByName",
  );
  if (!row) {
    throw new NotFoundError(`${treePath}/${name}`);
  }
  return mapRecord(row);
}

export async function patch(
  index: Index,
  id: string,
  priorVersionHash: string,
  input: PatchInput,
): Promise<StoredRecord> {
  const recordId = parseId(id);
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) {
    throwInvalidInput(parsed.error);
  }
  const data = parsed.data;

  if (
    data.embedding !== undefined &&
    data.embedding.length !== index.dimensions
  ) {
    throw new DimensionMismatchError(index.dimensions, data.embedding.length);
  }

  const patchObject: Record<string, unknown> = {};
  if (data.content !== undefined) patchObject.content = data.content;
  if (data.meta !== undefined) patchObject.meta = data.meta;
  if (data.tree !== undefined) patchObject.tree = data.tree;
  if (data.name !== undefined) patchObject.name = data.name;
  if (data.temporal !== undefined) {
    patchObject.temporal =
      data.temporal === null ? null : normalizeTemporalTuple(data.temporal);
  }

  const { sql } = index;
  const embedding =
    data.embedding === undefined
      ? sql`null`
      : index.vectorType === "halfvec"
        ? sql`${JSON.stringify(data.embedding)}::public.halfvec`
        : sql`${JSON.stringify(data.embedding)}::public.vector`;

  const [row] = await runRecordSql(
    sql<PatchRow[]>`
      select found, updated, id, content, meta, tree, temporal, name,
             has_embedding, version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.patch_record
      ( ${recordId}
      , ${priorVersionHash}
      , ${sql.json(patchObject as never)}::jsonb
      , ${embedding}
      )
    `,
    index.schema,
    "patchRecord",
  );
  if (!row?.found) {
    throw new NotFoundError(recordId);
  }
  if (!row.updated) {
    throw new StaleVersionError(recordId);
  }
  return mapRecord(row);
}

export async function deleteRecord(index: Index, id: string): Promise<void> {
  const recordId = parseId(id);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<{ ok: boolean }[]>`
      select ${sql(index.schema)}.delete_record(${recordId}) as ok
    `,
    index.schema,
    "deleteRecord",
  );
  if (!row?.ok) {
    throw new NotFoundError(recordId);
  }
}

export async function deleteByName(
  index: Index,
  tree: string,
  name: string,
): Promise<void> {
  const treePath = assertTreePath(tree);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<{ ok: boolean }[]>`
      select ${sql(index.schema)}.delete_record_by_name(${treePath}, ${name}) as ok
    `,
    index.schema,
    "deleteRecordByName",
  );
  if (!row?.ok) {
    throw new NotFoundError(`${treePath}/${name}`);
  }
}

async function runRecordSql<T extends readonly unknown[]>(
  query: postgres.PendingQuery<T & readonly object[]>,
  schema: string,
  spanName: string,
): Promise<T> {
  try {
    return (await runSql(query, {
      spanName,
      dbOperationName: "SELECT",
      namespace: schema,
    })) as T;
  } catch (error) {
    if (error instanceof SearchgresError) {
      throw error;
    }
    const code = postgresErrorCode(error);
    if (code === "23505") {
      throw new ConflictError("The target (tree, name) is already occupied", {
        cause: error,
      });
    }
    if (code === "22023") {
      throw new InvalidConfigError("Invalid patch input", { cause: error });
    }
    throw error;
  }
}

function mapRecord(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    content: row.content,
    meta: row.meta,
    tree: row.tree,
    temporal: row.temporal,
    name: row.name,
    hasEmbedding: row.has_embedding,
    version: row.version,
    versionHash: row.version_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) {
    throw new InvalidConfigError(
      `Invalid record id ${JSON.stringify(id)}: expected a UUIDv7`,
      { cause: result.error },
    );
  }
  return result.data;
}

function throwInvalidInput(error: z.ZodError): never {
  const issues = error.issues.map(toValidationIssue);
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "patch"}: ${first.message}`
    : "validation failed";
  throw new InvalidConfigError(`Invalid patch: ${detail}`, {
    cause: error,
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
