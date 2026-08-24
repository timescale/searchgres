import { z } from "zod";
import { InvalidConfigError, type ValidationIssue } from "./errors.ts";

export const DEFAULT_VECTOR_TYPE = "halfvec" as const;
export const DEFAULT_BM25_CONFIG = Object.freeze({
  textConfig: "english",
  k1: 1.2,
  b: 0.75,
});
export const DEFAULT_HNSW_CONFIG = Object.freeze({
  m: 16,
  efConstruction: 64,
});

export const MAX_VECTOR_DIMENSIONS = Object.freeze({
  // These are pgvector's HNSW limits, not the wider limits of the storage
  // types themselves. Every searchgres index creates an HNSW index.
  vector: 2000,
  halfvec: 4000,
});

const trimmedNonEmptyString = z
  .string()
  .min(1, "must be a non-empty string")
  .refine(
    (value) => value === value.trim(),
    "must not have surrounding whitespace",
  )
  .refine((value) => !value.includes("\0"), "must not contain NUL bytes");

const bm25Schema = z
  .object({
    textConfig: trimmedNonEmptyString.default(DEFAULT_BM25_CONFIG.textConfig),
    k1: z.number().min(0.1).max(10).default(DEFAULT_BM25_CONFIG.k1),
    b: z.number().min(0).max(1).default(DEFAULT_BM25_CONFIG.b),
  })
  .strict()
  .default(DEFAULT_BM25_CONFIG);

const hnswSchema = z
  .object({
    m: z.number().int().min(2).max(100).default(DEFAULT_HNSW_CONFIG.m),
    efConstruction: z
      .number()
      .int()
      .min(4)
      .max(1000)
      .default(DEFAULT_HNSW_CONFIG.efConstruction),
  })
  .strict()
  .default(DEFAULT_HNSW_CONFIG);

const indexConfigSchema = z
  .object({
    dimensions: z.number().int().positive(),
    vectorType: z.enum(["vector", "halfvec"]).default(DEFAULT_VECTOR_TYPE),
    bm25: bm25Schema,
    hnsw: hnswSchema,
  })
  .strict()
  .superRefine((config, context) => {
    const maximum = MAX_VECTOR_DIMENSIONS[config.vectorType];
    if (config.dimensions > maximum) {
      context.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: `must be between 1 and ${maximum} for ${config.vectorType}`,
      });
    }
  });

/** Caller-facing creation config, inferred from the runtime validator. */
export type IndexConfig = z.input<typeof indexConfigSchema>;

/** Fully validated and defaulted creation parameters used to build index DDL. */
export type NormalizedIndexConfig = z.output<typeof indexConfigSchema>;

export type VectorType = NormalizedIndexConfig["vectorType"];
export type Bm25Config = NonNullable<IndexConfig["bm25"]>;
export type HnswConfig = NonNullable<IndexConfig["hnsw"]>;
export type NormalizedBm25Config = NormalizedIndexConfig["bm25"];
export type NormalizedHnswConfig = NormalizedIndexConfig["hnsw"];

/** Validate caller input, apply defaults, and freeze the creation parameters. */
export function normalizeIndexConfig(
  input: IndexConfig,
): NormalizedIndexConfig {
  const result = indexConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "config"}: ${first.message}`
      : "validation failed";
    throw new InvalidConfigError(`Invalid index configuration: ${detail}`, {
      cause: result.error,
      issues,
    });
  }

  return deepFreeze(result.data);
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

function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === "object" && item !== null) {
      deepFreeze(item);
    }
  }
  return Object.freeze(value);
}
