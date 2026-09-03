import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import {
  createIndex,
  type Filter,
  type Index,
  openIndex,
  type SearchResult,
} from "searchgres";

async function retrieve(
  index: Index,
  question: string,
  trustedScope: Filter,
): Promise<readonly SearchResult[]> {
  return index.search({
    semantic: question,
    fulltext: question,
    filter: trustedScope,
    candidateLimit: 50,
    limit: 8,
  });
}

function formatContext(hits: readonly SearchResult[]): string {
  return hits
    .map(
      (hit, i) =>
        `<source n="${i + 1}" id="${hit.id}" tree="${hit.tree}">\n` +
        `${hit.content}\n</source>`,
    )
    .join("\n\n");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = postgres(databaseUrl);

try {
  await createIndex(sql, "example_rag", { dimensions: 1536 });
  const index = await openIndex(sql, "example_rag", {
    embedding: openai.embedding("text-embedding-3-small"),
  });

  await index.upsertMany([
    {
      tree: "tenants.acme.handbook.security",
      name: "chunk-0",
      content: "Production credentials rotate every 24 hours.",
      meta: { sourceId: "handbook", position: 0, visibility: "internal" },
    },
    {
      tree: "tenants.acme.handbook.api",
      name: "chunk-0",
      content: "API clients retry HTTP 429 responses with exponential backoff.",
      meta: { sourceId: "handbook", position: 1, visibility: "internal" },
    },
  ]);
  await index.processEmbeddings();

  // Construct this filter from authenticated identity, not request input.
  const trustedScope: Filter = {
    and: [{ tree: "tenants.acme" }, { meta: { visibility: "internal" } }],
  };
  const hits = await retrieve(
    index,
    "what should a client do when requests are throttled?",
    trustedScope,
  );
  console.log(formatContext(hits));
} finally {
  await sql.end();
}
