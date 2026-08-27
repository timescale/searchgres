# Searching records

Open an index, then call `search`. The retrieval mode is inferred from which
arms you supply — there is no `mode` parameter:

| Supplied | Behavior |
| --- | --- |
| `semantic` or `vector` only | Semantic cosine search |
| `fulltext` only | BM25 keyword search |
| a semantic arm **and** `fulltext` | Hybrid search (RRF fusion) |
| neither | Filter-only listing |

`semantic` is text that searchgres embeds with the index's model; `vector` is a
precomputed query vector that skips the model. They are mutually exclusive.

```ts
const hits = await index.search({
  semantic: "how are request limits enforced?",
  fulltext: "rate limit",
  filter: { tree: "docs.api" },
  limit: 20,
});
```

Every result is the full record plus a `score`:

```ts
type SearchResult = {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  name: string | null;
  hasEmbedding: boolean;
  version: string;
  versionHash: string;
  createdAt: Date;
  updatedAt: Date | null;
  score: number;
};
```

`score` is cosine similarity in `[-1, 1]` for a semantic arm, positive
unnormalized BM25 for keyword, a small positive RRF value for hybrid, and `-1`
for a filter-only listing.

## Filters

Filters are a composable boolean tree. Every leaf is a predicate on one record;
`and`, `or`, and `not` combine them. Filters apply to every mode.

```ts
await index.search({
  fulltext: "rate limit",
  filter: {
    and: [
      { tree: "docs.api" },
      { or: [{ meta: { source: "runbook" } }, { metaPredicate: "$.version >= 3" }] },
      { not: { regexp: "deprecated" } },
    ],
  },
});
```

Leaf types:

- `tree` — ancestor-or-self containment against a dotted `ltree` path.
- `lquery` — an `ltree` `lquery` pattern (e.g. `"docs.*.api"`).
- `ltxtquery` — an `ltree` label search (e.g. `"api & v2"`).
- `meta` — JSONB containment; must be a non-empty object.
- `metaPredicate` — a PostgreSQL JSONPath predicate evaluated with `@@`.
- `temporalWithin` / `temporalOverlaps` — a `[start, end]` range.
- `temporalBefore` / `temporalAfter` / `temporalContains` — a single timestamp.
- `regexp` — a case-insensitive POSIX match on `content`.

Rules:

- `and` and `or` need at least two children; `not` takes exactly one.
- Nesting is capped at depth 16 and 100 nodes total.
- Timestamps are `Date` or ISO-8601 with an explicit offset or `Z`; a range
  requires `start < end`.
- `regexp` may not be the only thing a filter-only search does — it must be
  accompanied by an indexable filter (`tree`, `lquery`, `ltxtquery`, `meta`, or
  temporal) on the same branch, and it may not appear under `not` in a
  filter-only search. A semantic or keyword arm already bounds the scan, so
  `regexp` is unrestricted there.

## Ranking controls

- `semanticThreshold` — minimum cosine similarity in `[0, 1]` (semantic/hybrid).
- `limit` — maximum results (default 10).
- `candidateLimit`, `k`, `fulltextWeight`, `semanticWeight` — hybrid RRF tuning
  (`k` defaults to 60, weights to 1, candidate pool to 30 per arm).

Hybrid search is a fused **top-k** operation: the score reflects rank position
within a candidate window, so it is not an absolute relevance measure and there
is no cursor. To see more, raise `limit`.

## Filter-only listing and pagination

A search with no arms lists records by `id` — which is chronological, since ids
are UUIDv7 — and supports keyset paging:

```ts
const first = await index.search({ order: "asc", limit: 100 });
const next = await index.search({
  order: "asc",
  after: first.at(-1)?.id,
  limit: 100,
});
```

`order`, `after`, and `before` apply only to filter-only listing; supplying them
with a ranking arm is rejected.

## Calling the routines from SQL

Search lives in schema-local PL/pgSQL routines created with the index —
`search_records`, `hybrid_search_records`, and `compile_filter` — so SQL
producers get the same contract:

```sql
select id, content, score
from docs_index.search_records(_fulltext => 'rate limit', _limit => 20);

select id, score
from docs_index.hybrid_search_records(
  _fulltext => 'rate limit',
  _vec => '[0.01, ...]'::public.halfvec,
  _filter => '{"tree":"docs.api"}'::jsonb
);
```

Filter values always travel as bound JSONB data; only the boolean structure
becomes SQL. Malformed input raises `invalid_parameter_value` (`22023`), which
the library maps to `InvalidConfigError`. Because the routine bodies are part of
the immutable schema format, changing their semantics requires a new index.
