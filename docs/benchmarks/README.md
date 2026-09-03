# Benchmarks and evidence

The architecture behind searchgres was tested on LoCoMo conversational memory
and MuSiQue multi-hop question answering before it was packaged as the
searchgres library.

The benchmark implementation was not the full Memory Engine product. It was a
simplified, unauthenticated search-core prototype much closer to what searchgres
ships: a Postgres record table, HNSW vectors, BM25, Reciprocal Rank Fusion, and
native structured filters. searchgres productizes that architecture with a
public TypeScript API, schema provisioning, validation, embedding lifecycle,
and operational tooling.

## Results at a glance

| Evaluation | Result | What it measured |
| --- | --- | --- |
| LoCoMo fixed retrieval baseline | `F1=0.493` | Embed question, hybrid search, provide fixed top results |
| LoCoMo agentic search | `F1=0.666` | Agent selected semantic, BM25, tree, temporal, and regex strategies |
| MuSiQue overall | `EM=0.440`, accuracy `0.600` | End-to-end answers on a seeded 100-question sample |
| MuSiQue retrieval | `86.5%` recall | Whether retrieved context contained the needed evidence |

The central result is not a current leaderboard claim. It is that a deliberately
simple Postgres-native retrieval design produced strong results without a
knowledge graph, fact-extraction pipeline, hierarchical summary index, or
separate vector database.

## LoCoMo

LoCoMo evaluates long-term conversational memory across single-hop, multi-hop,
temporal, open-domain, and adversarial questions. The experiment stored each
conversation turn as one record with:

- content plus searchable image descriptions;
- speaker and session hierarchy in `ltree`;
- metadata links to neighboring turns;
- represented time in `tstzrange`;
- OpenAI `text-embedding-3-small` vectors;
- BM25 and HNSW indexes.

An answering model searched through MCP tools rather than receiving one fixed
retrieval result.

### Findings

- Refining agentic search improved the same experimental system from
  `F1=0.493` with fixed retrieval to `F1=0.666`, a 35% relative improvement.
- Speaker-organized tree filtering added `0.023 F1` in the reported ablation.
- Requiring regex to act as a filter rather than an unranked standalone search
  added `0.091 F1` on open-domain questions.
- Adding image descriptions to searchable content improved temporal recall from
  `0.879` to `0.970`.
- LLM fact extraction produced effectively no change in one comparison
  (`F1=0.642` with extracted facts versus `0.641` without) while adding roughly
  50% ingestion time.
- Increasing retrieval depth eventually hurt adversarial accuracy: more context
  also introduced more noise.

These findings informed searchgres features and boundaries: composable filters,
regex scan protection, caller-controlled records, no mandatory extraction
pipeline, and explicit candidate limits.

## MuSiQue

MuSiQue contains compositional two-, three-, and four-hop questions over an
open-domain corpus. The experiment indexed 139,416 Wikipedia paragraphs in a
single Postgres table with HNSW and BM25 indexes. Claude Haiku iteratively used a
small MCP search tool; 93% of its searches used semantic and fulltext together.

On the seeded 100-question sample:

| Hops | F1 | Exact match | Accuracy | Retrieval recall |
| --- | ---: | ---: | ---: | ---: |
| 2 | 0.670 | 0.579 | 0.737 | 0.921 |
| 3 | 0.478 | 0.326 | 0.535 | 0.837 |
| 4 | 0.482 | 0.421 | 0.474 | 0.816 |
| Overall | 0.552 | 0.440 | 0.600 | 0.865 |

The gap between retrieval recall and answer accuracy suggests that reasoning,
not retrieval, was often the limiting stage.

### Findings

Several attempts to impose more retrieval policy made the sampled result worse:

- forcing hybrid search: `-0.127 F1`;
- increasing results from 10 to 20: `-0.092 F1`;
- adding strategy hints to tool descriptions: `-0.142 F1`;
- entity-enriching embedded content: `-0.045 F1`;
- adding a sub-question decomposition prompt: `-0.019 F1`.

The lesson for searchgres is not that every agent will choose perfectly. It is
that a retrieval engine should expose clear, composable primitives and let an
application choose policy rather than hard-coding one universal pipeline.

## How to interpret the results

These evaluations include more than a database query. End-to-end scores depend
on:

- corpus projection and chunking;
- embedding and answering models;
- prompts and tool descriptions;
- the agent's iterative search behavior;
- result formatting and context limits;
- sample selection and metric implementation.

The LoCoMo result used token-level F1, while many newer reports use exact
accuracy or LLM-as-judge metrics. LoCoMo results across those metrics should not
be treated as directly comparable, and this page makes no current SOTA claim.

The MuSiQue evaluation used a 100-question seeded sample rather than the
500-question split used by some cited work. Six mechanically composed dataset
items in the sample had entity-resolution errors and were documented during
manual failure review. Any direct comparison must account for the sample and
error policy.

## Reproducibility direction

The next step is to port the original harness to calls against the packaged
`searchgres` library and preserve it as a retrieval regression suite. A complete
reproduction should publish:

- dataset version and sample seed;
- source projection and tree conventions;
- embedding and answering model versions;
- prompts and MCP schemas;
- search settings and candidate limits;
- metric code and dataset-error policy;
- retrieval traces or experiment logs.

That work will strengthen reproducibility, but it is not a prerequisite for the
architectural conclusion: the schema and retrieval model that directly preceded
searchgres already produced the results reported above.

## Design conclusions

The evidence supports the design priorities used in searchgres:

1. combine lexical and semantic retrieval rather than relying on vectors alone;
2. make hierarchy, metadata, and represented time first-class filters;
3. keep filters composable so applications and agents can choose strategy;
4. preserve raw evidence and leave extraction or summarization to the caller;
5. expose candidate depth because additional context can hurt as well as help;
6. keep the storage and retrieval architecture simple enough to inspect and
   operate in PostgreSQL.
