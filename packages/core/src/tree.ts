import type postgres from "postgres";
import {
  ConflictError,
  InvalidConfigError,
  SearchgresError,
} from "./errors.ts";
import { assertTreePath } from "./identifiers.ts";
import type { Index } from "./open-index.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";

/** Options for the destructive/relocating tree operations. */
export interface TreeMutationOptions {
  /** Count affected rows without changing anything. */
  readonly dryRun?: boolean;
}

/** Outcome of a tree mutation (or the preview count under `dryRun`). */
export interface TreeMutationResult {
  readonly count: number;
}

/** Exactly one explicit filter kind selects the records to count. */
export type TreeCountSelector =
  | { readonly tree: string }
  | { readonly lquery: string }
  | { readonly ltxtquery: string };

export interface TreeCountOptions {
  /** Stop counting past this many matches (returns `capped: true`). */
  readonly limit?: number;
}

export interface TreeCountResult {
  readonly count: number;
  /** True when a `limit` was hit, so `count` is a lower bound, not exact. */
  readonly capped: boolean;
}

/** One node of a {@link Index.listTree} result: a tree path and its descendant count. */
export interface TreeListEntry {
  readonly tree: string;
  readonly count: number;
}

export async function moveTree(
  index: Index,
  source: string,
  destination: string,
  options?: TreeMutationOptions,
): Promise<TreeMutationResult> {
  const src = assertTreePath(source);
  const dst = assertTreePath(destination);
  const { sql } = index;
  const count = await runScalar(
    sql<{ n: string }[]>`
      select ${sql(index.schema)}.move_tree(${src}, ${dst}, ${options?.dryRun ?? false}) as n
    `,
    index.schema,
    "moveTree",
  );
  return { count };
}

export async function copyTree(
  index: Index,
  source: string,
  destination: string,
  options?: TreeMutationOptions,
): Promise<TreeMutationResult> {
  const src = assertTreePath(source);
  const dst = assertTreePath(destination);
  const { sql } = index;
  const count = await runScalar(
    sql<{ n: string }[]>`
      select ${sql(index.schema)}.copy_tree(${src}, ${dst}, ${options?.dryRun ?? false}) as n
    `,
    index.schema,
    "copyTree",
  );
  return { count };
}

export async function deleteTree(
  index: Index,
  tree: string,
  options?: TreeMutationOptions,
): Promise<TreeMutationResult> {
  const path = assertTreePath(tree);
  const { sql } = index;
  const count = await runScalar(
    sql<{ n: string }[]>`
      select ${sql(index.schema)}.delete_tree(${path}, ${options?.dryRun ?? false}) as n
    `,
    index.schema,
    "deleteTree",
  );
  return { count };
}

export async function countTree(
  index: Index,
  selector: TreeCountSelector,
  options?: TreeCountOptions,
): Promise<TreeCountResult> {
  const limit = options?.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new InvalidConfigError("countTree limit must be a positive integer");
  }
  // Ask for one past the limit so an exact count is distinguishable from a cap.
  const max = limit === undefined ? null : limit + 1;
  const { sql } = index;
  const value = resolveSelector(selector);
  const query =
    value.kind === "tree"
      ? sql<{ n: string }[]>`
          select ${sql(index.schema)}.count_tree(${value.value}::public.ltree, ${max}) as n
        `
      : value.kind === "lquery"
        ? sql<{ n: string }[]>`
            select ${sql(index.schema)}.count_tree(${value.value}::public.lquery, ${max}) as n
          `
        : sql<{ n: string }[]>`
            select ${sql(index.schema)}.count_tree(${value.value}::public.ltxtquery, ${max}) as n
          `;
  const raw = await runScalar(query, index.schema, "countTree");
  const capped = limit !== undefined && raw > limit;
  return { count: capped ? limit : raw, capped };
}

export async function listTree(
  index: Index,
  lquery: string,
): Promise<readonly TreeListEntry[]> {
  if (lquery.length === 0) {
    throw new InvalidConfigError("listTree requires a non-empty lquery");
  }
  const { sql } = index;
  const rows = await runTreeSql(
    sql<{ tree: string; count: string }[]>`
      select tree, count
      from ${sql(index.schema)}.list_tree(${lquery}::public.lquery)
    `,
    index.schema,
    "listTree",
  );
  return rows.map((row) => ({ tree: row.tree, count: Number(row.count) }));
}

function resolveSelector(selector: TreeCountSelector): {
  readonly kind: "tree" | "lquery" | "ltxtquery";
  readonly value: string;
} {
  const keys = Object.keys(selector);
  if (keys.length !== 1) {
    throw new InvalidConfigError(
      "countTree selector must have exactly one of tree, lquery, or ltxtquery",
    );
  }
  if ("tree" in selector) {
    return { kind: "tree", value: assertTreePath(selector.tree) };
  }
  if ("lquery" in selector) {
    return { kind: "lquery", value: nonEmpty(selector.lquery, "lquery") };
  }
  if ("ltxtquery" in selector) {
    return {
      kind: "ltxtquery",
      value: nonEmpty(selector.ltxtquery, "ltxtquery"),
    };
  }
  throw new InvalidConfigError(
    "countTree selector must have exactly one of tree, lquery, or ltxtquery",
  );
}

function nonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidConfigError(
      `countTree ${name} must be a non-empty string`,
    );
  }
  return value;
}

async function runScalar(
  query: postgres.PendingQuery<{ n: string }[]>,
  schema: string,
  spanName: string,
): Promise<number> {
  const [row] = await runTreeSql(query, schema, spanName);
  return Number(row?.n ?? 0);
}

async function runTreeSql<T extends readonly unknown[]>(
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
      throw new ConflictError("A destination (tree, name) already exists", {
        cause: error,
      });
    }
    throw error;
  }
}
