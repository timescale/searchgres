import { randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, dropIndex, openIndex } from "searchgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);
// A unique schema avoids conflicts between repeat or concurrent runs. Cleanup
// is guarded so the example can never remove a pre-existing caller schema.
const schema = `example_temporal_${randomUUID().replaceAll("-", "")}`;
let created = false;

try {
  await createIndex(sql, schema, { dimensions: 1536 });
  created = true;
  const index = await openIndex(sql, schema, {
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
  try {
    // Remove this run's temporary index even if a query fails.
    if (created) await dropIndex(sql, schema);
  } finally {
    await sql.end();
  }
}
