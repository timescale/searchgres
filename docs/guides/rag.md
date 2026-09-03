# Build a RAG retriever

searchgres can provide the retrieval stage of a RAG application without
prescribing chunking, prompting, or generation. This guide builds a small
retriever that combines semantic meaning, exact terms, and application scope.

## 1. Model and ingest chunks

Split source documents before the searchgres boundary. Preserve stable source
identity and chunk position so repeated ingestion updates in place:

```ts
await index.upsertMany(
  documents.flatMap((document) =>
    chunkDocument(document).map((chunk, position) => ({
      tree: `knowledge.${document.collection}.${document.slug}`,
      name: `chunk-${position}`,
      content: chunk.text,
      meta: {
        sourceId: document.id,
        title: document.title,
        position,
        visibility: document.visibility,
      },
    })),
  ),
  { onConflict: "replace" },
);
```

`chunkDocument` belongs to your application. It can preserve headings, attach
neighbor information, or use a tokenizer appropriate to the generation model.
searchgres treats each output as one searchable record.

## 2. Generate embeddings

Records work with BM25 and filters as soon as they are committed. Drain the
queue before expecting them in semantic or hybrid results:

```ts
await index.processEmbeddings({ batchSize: 50 });
```

For continuous ingestion, run `startEmbeddingWorker()` in a long-lived process.

## 3. Write a scoped retriever

Hybrid retrieval is a strong default for user questions because it preserves
both semantic and exact-term signals. Add mandatory application scope to keep
irrelevant or inaccessible records out of both candidate arms:

```ts
import type { Filter, Index, SearchResult } from "searchgres";

interface RetrievalScope {
  tenant: string;
  collection?: string;
  visibility: "public" | "internal";
}

export async function retrieve(
  index: Index,
  question: string,
  scope: RetrievalScope,
): Promise<readonly SearchResult[]> {
  const required: Filter[] = [
    {
      tree: scope.collection
        ? `tenants.${scope.tenant}.${scope.collection}`
        : `tenants.${scope.tenant}`,
    },
    { meta: { visibility: scope.visibility } },
  ];

  return index.search({
    semantic: question,
    fulltext: question,
    filter: { and: required },
    candidateLimit: 50,
    limit: 8,
  });
}
```

If the scope is an authorization boundary, construct it from trusted identity
rather than accepting it directly from an untrusted request. Do not expose an
unscoped index handle to that caller.

## 4. Format context

Every hit contains the full record, so context formatting can happen locally:

```ts
export function formatContext(hits: readonly SearchResult[]): string {
  return hits
    .map(
      (hit, index) =>
        `<source n="${index + 1}" id="${hit.id}" tree="${hit.tree}">\n` +
        `${hit.content}\n` +
        `</source>`,
    )
    .join("\n\n");
}
```

Keep stable source IDs in the formatted context so the answer can cite evidence
and your application can resolve it later.

## 5. Generate separately

Pass `formatContext(hits)` and the question to the model and prompt format your
application chooses. Keeping this stage separate has practical benefits:

- retrieval can be evaluated without generation variability;
- the same index can serve several models or prompts;
- access filters remain explicit;
- reranking or context budgeting can be inserted between retrieval and
  generation.

## Optional reranking

Core v1 does not include a reranker. Since search returns full records, rerank a
larger candidate set before formatting:

```ts
const candidates = await index.search({
  semantic: question,
  fulltext: question,
  filter: trustedScope,
  candidateLimit: 100,
  limit: 30,
});

const hits = await rerank(question, candidates, { limit: 8 });
```

The first-stage `candidateLimit` controls candidates inside RRF; the final
`limit: 30` controls how many fused records reach your reranker.

## Derived records

Summaries and extracted facts can be useful for some corpora, but they need not
replace source evidence. Store them under separate tree branches or in another
index:

```text
tenants.acme.raw.handbook.security
tenants.acme.summary.handbook.security
tenants.acme.facts.handbook.security
```

Use a tree or metadata filter to select one representation or search several.
A separate index is appropriate when derived records use a different embedding
model or retrieval policy.

## Evaluate retrieval

Create a set of representative questions with known relevant record IDs. Track
at least:

- recall at the context limit;
- precision or irrelevant-context rate;
- results by question category;
- latency, including query embedding;
- failures caused by indexing or filters versus failures caused by generation.

Tune chunking, `candidateLimit`, `semanticThreshold`, and hybrid weights from
those results. More context is not automatically better.

Next: [Run in production](production.md).
