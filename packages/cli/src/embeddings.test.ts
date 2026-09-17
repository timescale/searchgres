import { expect, test } from "bun:test";
import type { EmbeddingFailure } from "searchgres";
import { retryAll } from "./embeddings.ts";

test("retry all traverses pages once with decimal strings and accumulates skipped changes", async () => {
  const cursors: (string | undefined)[] = [];
  const ids: string[][] = [];
  const result = await retryAll({
    async listEmbeddingFailures(options) {
      cursors.push(options?.after);
      if (!options?.after)
        return Array.from(
          { length: 1000 },
          (_, i) =>
            ({
              queueId: String(9007199254740993n + BigInt(i)),
            }) as EmbeddingFailure,
        );
      return [{ queueId: "9007199254741993" } as EmbeddingFailure];
    },
    async retryEmbeddingFailures(options) {
      ids.push([...options.queueIds]);
      return { retried: options.queueIds.length - 1, skipped: 1 };
    },
  });
  expect(cursors).toEqual([undefined, "9007199254741992"]);
  expect(ids.map((page) => page.length)).toEqual([1000, 1]);
  expect(result).toEqual({ retried: 999, skipped: 2 });
});
