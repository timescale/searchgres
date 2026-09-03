import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);

try {
  await createIndex(sql, "example_temporal", { dimensions: 1536 });
  const index = await openIndex(sql, "example_temporal", {
    embedding: openai.embedding("text-embedding-3-small"),
  });

  await index.upsertMany([
    {
      tree: "operations.incidents",
      name: "incident-42",
      content: "Elevated API latency during a database failover.",
      temporal: ["2026-03-10T14:00:00Z", "2026-03-10T14:37:00Z"],
      meta: { severity: 2 },
    },
    {
      tree: "operations.releases",
      name: "release-7",
      content: "Version 7 was released.",
      temporal: ["2026-03-10T15:00:00Z"],
      meta: { version: 7 },
    },
  ]);

  const duringIncident = await index.search({
    filter: {
      and: [
        { tree: "operations" },
        { temporalContains: "2026-03-10T14:15:00Z" },
      ],
    },
  });

  const marchEvents = await index.search({
    fulltext: "database release latency",
    filter: {
      temporalOverlaps: ["2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"],
    },
  });

  console.log({ duringIncident, marchEvents });
} finally {
  await sql.end();
}
