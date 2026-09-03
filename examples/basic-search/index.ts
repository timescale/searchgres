import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);

try {
  await createIndex(sql, "example_basic", { dimensions: 1536 });
  const index = await openIndex(sql, "example_basic", {
    embedding: openai.embedding("text-embedding-3-small"),
  });

  await index.upsertMany([
    {
      tree: "docs.auth",
      name: "rotation",
      content: "Authentication tokens rotate every 24 hours.",
      meta: { audience: "operators" },
    },
    {
      tree: "docs.api",
      name: "limits",
      content: "Each API key is limited to 100 requests per minute.",
      meta: { audience: "developers" },
    },
  ]);

  console.log(await index.processEmbeddings());

  const hits = await index.search({
    semantic: "how are requests throttled?",
    fulltext: "API rate limit",
    filter: {
      and: [{ tree: "docs.api" }, { meta: { audience: "developers" } }],
    },
    limit: 5,
  });

  for (const hit of hits) {
    console.log(hit.score.toFixed(4), hit.tree, hit.content);
  }

  await index.drop();
} finally {
  await sql.end();
}
