import { z } from "zod";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  InvalidConfigError,
  type ValidationIssue,
} from "./errors.ts";
import type { Index } from "./open-index.ts";
import { runSql } from "./sql/exec.ts";

const MAX_UPSERT_BATCH_SIZE = 1000;

const timestampSchema = z.union([z.date(), z.iso.datetime({ offset: true })]);
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

interface NormalizedRecord {
  readonly id: string | null;
  readonly content: string;
  readonly meta: z.output<typeof recordSchema>["meta"];
  readonly tree: string;
  readonly temporalStart: string | null;
  readonly temporalEnd: string | null;
  readonly temporalBounds: "[]" | "[)" | null;
  readonly name: string | null;
  readonly embedding: readonly number[] | null;
}

interface UpsertRow {
  readonly position: string;
  readonly id: string | null;
  readonly source_id: string;
  readonly tree: string;
  readonly name: string | null;
  readonly status: "inserted" | "updated" | "skipped";
}

/** Validate, normalize, and write a batch of records in one SQL statement. */
export async function upsertMany(
  index: Index,
  records: readonly UpsertRecord[],
  options?: UpsertOptions,
): Promise<readonly UpsertResult[]> {
  if (records.length > MAX_UPSERT_BATCH_SIZE) {
    throw new BatchTooLargeError(records.length, MAX_UPSERT_BATCH_SIZE);
  }

  const parsedRecords = parseRecords(records);
  const parsedOptions = parseOptions(options);
  const normalized = parsedRecords.map((record) => normalizeRecord(record));
  assertDistinctIdempotencyKeys(normalized);
  for (const record of normalized) {
    if (record.embedding && record.embedding.length !== index.dimensions) {
      throw new DimensionMismatchError(
        index.dimensions,
        record.embedding.length,
      );
    }
  }
  if (normalized.length === 0) {
    return [];
  }

  const rows = await index.sql.begin(async (tx) => {
    const vector = index.extensions.find(
      (extension) => extension.name === "vector",
    );
    const ltree = index.extensions.find(
      (extension) => extension.name === "ltree",
    );
    if (!vector || !ltree) {
      throw new Error("Opened index is missing required extension metadata");
    }

    const operatorSchemas = [
      ...new Set([index.schema, vector.schema, ltree.schema]),
    ];
    await runSql(
      tx`set local search_path to pg_catalog, ${tx(operatorSchemas)}, pg_temp`,
      {
        spanName: "setLocalWriteSearchPath",
        dbOperationName: "SET",
        namespace: index.schema,
      },
    );
    await assertNoCrossKeyCollisions(tx, index, normalized);
    const vectorType = tx`${tx(vector.schema)}.${tx(index.vectorType)}`;
    const ltreeType = tx`${tx(ltree.schema)}.ltree`;
    const replaceAction =
      parsedOptions.onConflict === "replace"
        ? tx`
            do update
            set content = excluded.content
            , meta = excluded.meta
            , tree = excluded.tree
            , temporal = excluded.temporal
            , name = excluded.name
            , embedding = case
                when excluded.embedding is null
                  and record.content is not distinct from excluded.content
                then record.embedding
                else excluded.embedding
              end
            where record.content is distinct from excluded.content
              or record.meta is distinct from excluded.meta
              or record.tree is distinct from excluded.tree
              or record.temporal is distinct from excluded.temporal
              or (
                excluded.embedding is not null
                and record.embedding::text is distinct from excluded.embedding::text
              )
          `
        : tx`do nothing`;
    const namedConflictAction = tx`
      on conflict (tree, name) where name is not null ${replaceAction}
    `;
    const idConflictAction = tx`on conflict (id) ${replaceAction}`;

    const query = tx<UpsertRow[]>`
      with source as
      (
        select
          values.ordinality::integer as position
        , values.id as explicit_id
        , coalesce(values.id, pg_catalog.uuidv7()) as id
        , values.content
        , pg_catalog.jsonb_array_element(${tx.json(normalized.map((record) => record.meta))}::jsonb, values.ordinality::integer - 1) as meta
        , values.tree::${ltreeType} as tree
        , case
            when values.temporal_start is null then null
            else pg_catalog.tstzrange(
              values.temporal_start,
              values.temporal_end,
              values.temporal_bounds
            )
          end as temporal
        , values.name
        , values.embedding::${vectorType} as embedding
        from unnest
        (
          ${normalized.map((record) => record.id)}::uuid[]
        , ${normalized.map((record) => record.content)}::text[]
        , ${normalized.map((record) => record.tree)}::text[]
        , ${normalized.map((record) => record.temporalStart)}::timestamptz[]
        , ${normalized.map((record) => record.temporalEnd)}::timestamptz[]
        , ${normalized.map((record) => record.temporalBounds)}::text[]
        , ${normalized.map((record) => record.name)}::text[]
        , ${normalized.map((record) => encodeEmbedding(record.embedding))}::text[]
        ) with ordinality as values
        (
          id
        , content
        , tree
        , temporal_start
        , temporal_end
        , temporal_bounds
        , name
        , embedding
        , ordinality
        )
      )
    , named_mutation as
      (
        insert into ${tx(index.schema)}.record as record
          (id, content, meta, tree, temporal, name, embedding)
        select id, content, meta, tree, temporal, name, embedding
        from source
        where name is not null
        ${namedConflictAction}
        returning
          record.id
        , record.tree::text as tree
        , record.name
        , (xmax = 0) as inserted
      )
    , id_mutation as
      (
        insert into ${tx(index.schema)}.record as record
          (id, content, meta, tree, temporal, name, embedding)
        select id, content, meta, tree, temporal, name, embedding
        from source
        where name is null and explicit_id is not null
        ${idConflictAction}
        returning
          record.id
        , record.tree::text as tree
        , record.name
        , (xmax = 0) as inserted
      )
    , anonymous_mutation as
      (
        insert into ${tx(index.schema)}.record as record
          (id, content, meta, tree, temporal, name, embedding)
        select id, content, meta, tree, temporal, name, embedding
        from source
        where name is null and explicit_id is null
        returning
          record.id
        , record.tree::text as tree
        , record.name
        , true as inserted
      )
    , mutation as
      (
        select id, tree, name, inserted from named_mutation
        union all
        select id, tree, name, inserted from id_mutation
        union all
        select id, tree, name, inserted from anonymous_mutation
      )
      select
        source.position
      , mutation.id
      , source.id as source_id
      , source.tree::text as tree
      , source.name
      , case
          when mutation.id is null then 'skipped'
          when mutation.inserted then 'inserted'
          else 'updated'
        end as status
      from source
      left join mutation
        on (
          source.name is not null
          and mutation.tree = source.tree::text
          and mutation.name = source.name
        )
        or (
          source.name is null
          and mutation.id = source.id
        )
      order by source.position
    `;
    const written = await runSql(query, {
      spanName: "upsertMany",
      dbOperationName: "INSERT",
      namespace: index.schema,
    });
    const skippedNamed = written.filter(
      (row) => row.status === "skipped" && row.name !== null,
    );
    const resolvedNamed = await resolveSkippedNamedRows(
      tx,
      index,
      skippedNamed,
    );
    const results = written.map((row) => {
      const id =
        row.id ??
        (row.name === null
          ? row.source_id
          : resolvedNamed.get(`${row.tree}\0${row.name}`));
      if (!id) {
        throw new ConflictError(
          "A conflicting named record disappeared before its result could be resolved",
        );
      }
      return { id, status: row.status };
    });
    if (
      parsedOptions.onConflict === "error" &&
      results.some((row) => row.status === "skipped")
    ) {
      throw new ConflictError(
        "One or more records conflict with existing records",
      );
    }
    return results;
  });

  return rows;
}

function parseRecords(
  records: readonly UpsertRecord[],
): readonly z.output<typeof recordSchema>[] {
  const result = z.array(recordSchema).safeParse(records);
  if (!result.success) {
    throwInvalidRecordInput(result.error);
  }
  return result.data;
}

function parseOptions(
  options: UpsertOptions | undefined,
): z.output<typeof upsertOptionsSchema> {
  const result = upsertOptionsSchema.safeParse(options);
  if (!result.success) {
    throwInvalidRecordInput(result.error);
  }
  return result.data;
}

function throwInvalidRecordInput(error: z.ZodError): never {
  const issues = error.issues.map(toValidationIssue);
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "record"}: ${first.message}`
    : "validation failed";
  throw new InvalidConfigError(`Invalid record input: ${detail}`, {
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

function normalizeRecord(
  record: z.output<typeof recordSchema>,
): NormalizedRecord {
  const temporal = normalizeTemporal(record.temporal);
  return {
    id: record.id ?? null,
    content: record.content,
    meta: record.meta,
    tree: record.tree,
    temporalStart: temporal?.start ?? null,
    temporalEnd: temporal?.end ?? null,
    temporalBounds: temporal?.bounds ?? null,
    name: record.name,
    embedding: record.embedding ?? null,
  };
}

function assertDistinctIdempotencyKeys(
  records: readonly NormalizedRecord[],
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const record of records) {
    if (record.id !== null) {
      if (ids.has(record.id)) {
        throw duplicateKeyError("duplicate explicit id within batch");
      }
      ids.add(record.id);
    }
    if (record.name !== null) {
      const key = `${record.tree}\0${record.name}`;
      if (names.has(key)) {
        throw duplicateKeyError("duplicate (tree, name) within batch");
      }
      names.add(key);
    }
  }
}

async function assertNoCrossKeyCollisions(
  tx: import("postgres").TransactionSql,
  index: Index,
  records: readonly NormalizedRecord[],
): Promise<void> {
  const ids = records
    .filter((record) => record.name === null && record.id !== null)
    .map((record) => record.id as string);
  const names = records.filter((record) => record.name !== null);
  if (ids.length === 0 || names.length === 0) {
    return;
  }
  const [collision] = await runSql(
    tx<{ readonly id: string }[]>`
      select id
      from
      (
        select record.id
        from ${tx(index.schema)}.record
        where id = any(${ids}::uuid[])
        union all
        select record.id
        from ${tx(index.schema)}.record
        join unnest(
          ${names.map((record) => record.tree)}::text[],
          ${names.map((record) => record.name)}::text[]
        ) as key(tree, name)
          on record.tree::text = key.tree
          and record.name = key.name
      ) as targets
      group by id
      having count(*) > 1
      limit 1
    `,
    {
      spanName: "checkUpsertCrossKeyCollisions",
      dbOperationName: "SELECT",
      namespace: index.schema,
    },
  );
  if (collision) {
    throw duplicateKeyError(
      "batch inputs target the same existing record through id and (tree, name)",
    );
  }
}

async function resolveSkippedNamedRows(
  tx: import("postgres").TransactionSql,
  index: Index,
  rows: readonly UpsertRow[],
): Promise<ReadonlyMap<string, string>> {
  if (rows.length === 0) {
    return new Map();
  }
  const resolved = await runSql(
    tx<{ readonly id: string; readonly tree: string; readonly name: string }[]>`
      select record.id, record.tree::text as tree, record.name
      from ${tx(index.schema)}.record
      join unnest(
        ${rows.map((row) => row.tree)}::text[],
        ${rows.map((row) => row.name)}::text[]
      ) as key(tree, name)
        on record.tree::text = key.tree
        and record.name = key.name
    `,
    {
      spanName: "resolveSkippedNamedUpserts",
      dbOperationName: "SELECT",
      namespace: index.schema,
    },
  );
  return new Map(resolved.map((row) => [`${row.tree}\0${row.name}`, row.id]));
}

function duplicateKeyError(message: string): InvalidConfigError {
  return new InvalidConfigError(`Invalid record input: ${message}`, {
    issues: [{ code: "custom", message, path: [] }],
  });
}

function normalizeTemporal(
  temporal: z.output<typeof temporalSchema> | undefined,
):
  | {
      readonly start: string;
      readonly end: string;
      readonly bounds: "[]" | "[)";
    }
  | undefined {
  if (!temporal) {
    return undefined;
  }
  const start = normalizeTimestamp(temporal[0]);
  if (temporal.length === 1) {
    return { start, end: start, bounds: "[]" };
  }
  const end = normalizeTimestamp(temporal[1]);
  return { start, end, bounds: "[)" };
}

function normalizeTimestamp(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function timestampMilliseconds(timestamp: Date | string): number {
  return timestamp instanceof Date
    ? timestamp.getTime()
    : Date.parse(timestamp);
}

function encodeEmbedding(embedding: readonly number[] | null): string | null {
  return embedding === null ? null : JSON.stringify(embedding);
}
