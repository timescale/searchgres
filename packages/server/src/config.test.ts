import { describe, expect, test } from "bun:test";
import { parseServerConfig } from "./config.ts";

const minimalConfig = {
  version: 1,
  server: { listen: {} },
  database: { urlEnv: "SEARCHGRES_DATABASE_URL" },
  index: {
    schema: "docs",
    embedding: { provider: "openai-compatible", model: "test-model" },
  },
};

describe("server config", () => {
  test("applies one-index pool, timeout, and worker defaults", () => {
    const config = parseServerConfig(minimalConfig);
    expect(config.server.listen.host).toBe("127.0.0.1");
    expect(config.database.api.pool.max).toBe(20);
    expect(config.database.worker.pool.max).toBe(2);
    expect(config.database.api.session.statementTimeout).toBe(30_000);
    expect(config.database.worker.session.statementTimeout).toBe(25_000);
    expect(config.index.worker.interval).toBe(1_000);
  });

  test("accepts curated exact tokenization with an inline escape hatch", () => {
    const config = parseServerConfig({
      ...minimalConfig,
      index: {
        ...minimalConfig.index,
        truncate: {
          kind: "tokens",
          tokenizer: "nomic-modernbert-embed-base",
          maxTokens: 512,
          threads: 0,
        },
      },
    });
    expect(config.index.truncate).toEqual({
      kind: "tokens",
      tokenizer: "nomic-modernbert-embed-base",
      maxTokens: 512,
      threads: 0,
    });
  });

  test("rejects unknown keys and raw provider credentials", () => {
    expect(() =>
      parseServerConfig({
        ...minimalConfig,
        index: {
          ...minimalConfig.index,
          embedding: {
            ...minimalConfig.index.embedding,
            apiKey: "not allowed",
          },
        },
      }),
    ).toThrow();
  });
});
