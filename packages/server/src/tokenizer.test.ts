import { describe, expect, test } from "bun:test";
import { truncateText } from "./tokenizer.ts";
import { TokenizerPool } from "./tokenizer-pool.ts";

describe("curated token truncation", () => {
  test("cl100k keeps an exact bounded token prefix", async () => {
    await expect(
      truncateText(
        { preset: "openai-cl100k-base", maxTokens: 2 },
        "hello world there",
      ),
    ).resolves.toBe("hello world");
  });

  test("loads the model-pinned Nomic WordPiece and ByteLevel BPE assets", async () => {
    await expect(
      truncateText(
        { preset: "nomic-embed-text-v1.5", maxTokens: 2 },
        "Hello world there",
      ),
    ).resolves.toBe("hello world");
    await expect(
      truncateText(
        { preset: "nomic-modernbert-embed-base", maxTokens: 2 },
        "Hello world there",
      ),
    ).resolves.toBe("Hello world");
  });

  test("uses a batched worker request and shuts the pool down", async () => {
    const pool = new TokenizerPool({
      preset: "openai-cl100k-base",
      maxTokens: 2,
      threads: 1,
    });
    try {
      await expect(
        pool.truncateMany(["hello world there", "second string here"]),
      ).resolves.toEqual(["hello world", "second string"]);
    } finally {
      await pool.shutdown();
    }
  });

  test("supports constrained deployments without a worker thread", async () => {
    const pool = new TokenizerPool({
      preset: "nomic-embed-text-v1.5",
      maxTokens: 2,
      threads: 0,
    });
    await expect(pool.truncate("Hello world there")).resolves.toBe(
      "hello world",
    );
    await pool.shutdown();
  });
});
