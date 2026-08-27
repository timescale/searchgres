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
