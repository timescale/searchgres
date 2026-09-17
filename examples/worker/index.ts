import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { openIndex, SearchgresError } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);
const index = await openIndex(sql, "application_search", {
  embedding: openai.embedding("text-embedding-3-small"),
});
const worker = index.startEmbeddingWorker({
  batchSize: 100,
  intervalMs: 1_000,
  pruneRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  onError(error, { phase, consecutiveErrors, backoffMs }) {
    // Avoid logging raw provider/driver diagnostics, which may contain secrets.
    const code = error instanceof SearchgresError ? error.code : "INTERNAL";
    console.error({ code, phase, consecutiveErrors, backoffMs });
  },
});
// Ordinary provider failures do not invoke onError. Monitor queueStats() and
// inspect listEmbeddingFailures() separately; see the embedding guide.

console.log(`draining ${index.schema}; press Ctrl-C to stop`);

await new Promise<void>((resolve) => {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await worker.stop();
    await sql.end();
    resolve();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
});
