import { randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, dropIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);
// Use a per-run schema so this example is safe to repeat or run concurrently.
// `created` ensures cleanup touches only the schema this process provisioned.
const schema = `example_documents_${randomUUID().replaceAll("-", "")}`;
let created = false;

try {
  await createIndex(sql, schema, { dimensions: 1536 });
  created = true;
  const index = await openIndex(sql, schema, {
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
  try {
    // Drop temporary state on success and on failures after provisioning.
    if (created) await dropIndex(sql, schema);
  } finally {
    await sql.end();
  }
}
