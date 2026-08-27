import type { EmbeddingModelV4 } from "@ai-sdk/provider";

export interface MockEmbeddingModel extends EmbeddingModelV4 {
  /** Text values passed to `doEmbed`, in call order. */
  readonly calls: string[];
}

/**
 * A deterministic embedding model for tests. `vectors` maps an exact input
 * string to the vector returned for it; unknown inputs fall back to `fallback`.
 */
export function mockEmbeddingModel(
  vectors: Record<string, readonly number[]>,
  fallback: readonly number[] = [0, 0, 0, 0],
): MockEmbeddingModel {
  const calls: string[] = [];
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-embedding",
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
    calls,
    doEmbed({ values }) {
      const embeddings = values.map((value) => {
        calls.push(value);
        return [...(vectors[value] ?? fallback)];
      });
      return Promise.resolve({
        embeddings,
        usage: { tokens: 0 },
        warnings: [],
      });
    },
  };
}

export interface ControllableEmbeddingModel extends EmbeddingModelV4 {
  /** Each batch of values passed to `doEmbed`, in call order. */
  readonly batches: string[][];
  /** Replace the embedding behavior. Return one vector per input value. */
  handler: (values: string[]) => number[][] | Promise<number[][]>;
}

/**
 * A test embedding model whose behavior is swappable at runtime, so a test can
 * inject failures, rate limits, wrong dimensions, or mid-embed side effects.
 */
export function controllableEmbeddingModel(options?: {
  readonly maxEmbeddingsPerCall?: number;
  readonly handler?: (values: string[]) => number[][] | Promise<number[][]>;
}): ControllableEmbeddingModel {
  const batches: string[][] = [];
  const model: ControllableEmbeddingModel = {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "controllable-embedding",
    maxEmbeddingsPerCall: options?.maxEmbeddingsPerCall ?? 100,
    supportsParallelCalls: true,
    batches,
    handler: options?.handler ?? ((values) => values.map(() => [1, 0, 0, 0])),
    async doEmbed({ values }) {
      batches.push([...values]);
      const embeddings = await model.handler([...values]);
      return { embeddings, usage: { tokens: 0 }, warnings: [] };
    },
  };
  return model;
}

/** An AI SDK-shaped HTTP 429 error for exercising rate-limit handling. */
export function rateLimitError(retryAfterMs?: number): Error {
  const error = new Error("Too Many Requests") as Error & {
    statusCode: number;
    responseHeaders: Record<string, string>;
  };
  error.statusCode = 429;
  error.responseHeaders =
    retryAfterMs === undefined
      ? {}
      : { "retry-after-ms": String(retryAfterMs) };
  return error;
}
