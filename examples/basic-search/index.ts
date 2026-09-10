import { randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, dropIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);
// A unique schema makes concurrent and repeated example runs independent. Track
// ownership so cleanup never drops a schema that existed before this process.
const schema = `example_basic_${randomUUID().replaceAll("-", "")}`;
let created = false;

try {
  await createIndex(sql, schema, { dimensions: 1536 });
  created = true;
  const index = await openIndex(sql, schema, {
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
} finally {
  try {
    // Keep the runnable example repeatable even if ingestion or search fails.
    if (created) await dropIndex(sql, schema);
  } finally {
    await sql.end();
  }
}
