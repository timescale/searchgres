import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);

try {
  await createIndex(sql, "example_documents", { dimensions: 1536 });
  const index = await openIndex(sql, "example_documents", {
    embedding: openai.embedding("text-embedding-3-small"),
  });

  await index.upsertMany(
    [
      {
        tree: "knowledge.raw.api_limits",
        name: "chunk-0",
        content: "API keys allow 100 requests per minute.",
        meta: { sourceId: "api-limits", kind: "raw", position: 0 },
      },
      {
        tree: "knowledge.raw.api_limits",
        name: "chunk-1",
        content: "The service returns HTTP 429 after the quota is exhausted.",
        meta: { sourceId: "api-limits", kind: "raw", position: 1 },
      },
      {
        tree: "knowledge.summary.api_limits",
        name: "current",
        content:
          "API usage is capped per minute and excess requests return 429.",
        meta: { sourceId: "api-limits", kind: "summary" },
      },
    ],
    { onConflict: "replace" },
  );
  await index.processEmbeddings();

  const rawEvidence = await index.search({
    semantic: "what happens after exceeding the quota?",
    fulltext: "quota HTTP 429",
    filter: {
      and: [{ tree: "knowledge.raw" }, { meta: { sourceId: "api-limits" } }],
    },
  });

  console.log(
    rawEvidence.map(({ tree, name, content }) => ({ tree, name, content })),
  );
} finally {
  await sql.end();
}
