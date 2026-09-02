import { JSON5, YAML } from "bun";
import { z } from "zod";

const durationPattern = /^(\d+)(ms|s|m|h|d)$/;
const maximumDimensions = { vector: 2_000, halfvec: 4_000 } as const;

function durationToMilliseconds(value: string): number {
  const match = durationPattern.exec(value);
  if (!match) {
    throw new Error(
      "duration must be an integer followed by ms, s, m, h, or d",
    );
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return amount * multiplier;
}

const durationSchema = z
  .string()
  .regex(durationPattern, "expected an integer duration with ms, s, m, h, or d")
  .transform(durationToMilliseconds);

const poolSchema = z.strictObject({
  max: z.number().int().min(1).prefault(20),
  idleReap: durationSchema.prefault("5m"),
  maxLifetime: durationSchema.prefault("0s"),
  connectTimeout: durationSchema.prefault("30s"),
});
const sessionSchema = z.strictObject({
  statementTimeout: durationSchema.prefault("30s"),
  lockTimeout: durationSchema.prefault("5s"),
  transactionTimeout: durationSchema.prefault("35s"),
  idleInTransactionSessionTimeout: durationSchema.prefault("35s"),
});
const databaseRoleSchema = z.strictObject({
  pool: poolSchema.prefault({}),
  session: sessionSchema.prefault({}),
});
const workerDatabaseRoleSchema = z.strictObject({
  pool: poolSchema.prefault({ max: 2 }),
  session: sessionSchema.prefault({
    statementTimeout: "25s",
    lockTimeout: "5s",
    transactionTimeout: "30s",
    idleInTransactionSessionTimeout: "30s",
  }),
});
const truncationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("characters"),
    max: z.number().int().min(1),
  }),
  z.strictObject({ kind: z.literal("bytes"), max: z.number().int().min(1) }),
  z.strictObject({
    kind: z.literal("tokens"),
    tokenizer: z.enum([
      "openai-cl100k-base",
      "nomic-embed-text-v1.5",
      "nomic-modernbert-embed-base",
    ]),
    maxTokens: z.number().int().min(1),
    threads: z.number().int().min(0).max(64).optional(),
  }),
]);

export const serverConfigSchema = z.strictObject({
  version: z.literal(1),
  server: z.strictObject({
    listen: z
      .strictObject({
        host: z.string().prefault("127.0.0.1"),
        port: z.number().int().min(1).max(65535).prefault(3000),
      })
      .prefault({}),
    maxRequestBodyBytes: z
      .number()
      .int()
      .min(1)
      .prefault(1024 * 1024),
  }),
  database: z.strictObject({
    urlEnv: z.string().min(1),
    api: databaseRoleSchema.prefault({}),
    worker: workerDatabaseRoleSchema.prefault({}),
  }),
  index: z
    .strictObject({
      schema: z.string().min(1),
      dimensions: z.number().int().positive(),
      vectorType: z.enum(["vector", "halfvec"]),
      embedding: z.strictObject({
        provider: z.literal("openai-compatible"),
        model: z.string().min(1),
        baseUrl: z.url().optional(),
        apiKeyEnv: z.string().min(1).optional(),
      }),
      truncate: truncationSchema.prefault({ kind: "none" }),
      worker: z
        .strictObject({
          interval: durationSchema.prefault("1s"),
          batchSize: z.number().int().min(1).max(1000).prefault(100),
        })
        .prefault({}),
    })
    .superRefine((index, context) => {
      const maximum = maximumDimensions[index.vectorType];
      if (index.dimensions > maximum) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `must be between 1 and ${maximum} for ${index.vectorType}`,
        });
      }
    }),
});

export type ServerConfig = z.output<typeof serverConfigSchema>;

export function parseServerConfig(value: unknown): ServerConfig {
  return serverConfigSchema.parse(value);
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
  const source = await Bun.file(path).text();
  const lower = path.toLowerCase();
  let parsed: unknown;
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    parsed = YAML.parse(source);
  } else if (lower.endsWith(".json5")) {
    parsed = JSON5.parse(source);
  } else {
    throw new Error(
      "server config must have a .yaml, .yml, or .json5 extension",
    );
  }
  return parseServerConfig(parsed);
}

export function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}
