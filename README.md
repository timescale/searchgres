# searchgres

Postgres-native search for TypeScript. Semantic (vector), keyword (BM25), and
hybrid retrieval — with composable hierarchy, metadata, temporal, and regex
filters — over a PostgreSQL database you own and run.

> **Status: pre-release, under active development.** The core library, API
> server, client, CLI, and stdio MCP server are implemented. Expect breaking
> changes until `1.0`.

## Why searchgres

Most RAG stacks bolt a separate vector database onto the side of the database
that already holds your data, then reconcile two systems forever. searchgres
keeps retrieval where your data lives: real BM25 keyword search, HNSW vector
search, and rank fusion — all executed in Postgres, filtered by the same query.

- **Semantic, keyword, and hybrid** in one call, with the mode inferred from the
  arms you pass.
- **Filters that compose** — scope by tree path, JSONB metadata (containment or
  JSONPath), a time range, or a regex, combined with `and`/`or`/`not`.
- **Bring your own embedding model** — any [AI SDK](https://sdk.vercel.ai)
  provider or a custom implementation. searchgres never touches your credentials.
- **Your database, your connection** — you pass a
  [`postgres.js`](https://github.com/porsager/postgres) pool; the library never
  opens or closes it.
- **Async embedding built in** — writes are fast; records become semantically
  searchable as a queue is drained, by an in-process worker or on demand.
- **Runs anywhere JavaScript does** — Node, Bun, and Deno.

## Requirements

- **PostgreSQL 18** with three extensions in the `public` schema:
  [`pgvector`](https://github.com/pgvector/pgvector),
  [`pg_textsearch`](https://github.com/timescale/pg_textsearch), and `ltree`.
- **Node ≥ 22**, **Bun ≥ 1.4**, or **Deno ≥ 2.0**.

A Dockerfile that builds PostgreSQL 18 with all three extensions is included for
local development. See [Install searchgres](docs/installation.md).

## Evaluate locally with no API key

The repository includes an evaluation-only stack with PostgreSQL, Ollama,
automatic `nomic-embed-text` download, strict index provisioning, and the API
server:

```bash
git clone https://github.com/timescale/searchgres.git
cd searchgres
docker compose up --build
```

When `server` is healthy, Searchgres is available at
`http://127.0.0.1:3000`. The first run downloads several gigabytes of images and
may take a few minutes. No generated config, provider account, or API key is
needed. See [Evaluate with Docker Compose](docs/guides/docker-compose.md) for
sample commands, restart/reset behavior, and the evaluation-only security
boundary.

### Evaluation performance

This stack optimizes for a free, zero-configuration evaluation, not maximum
embedding throughput. Its Ollama service runs `nomic-embed-text` on CPU in the
container runtime's Linux VM; the stack does not configure GPU access. That is a
property of this evaluation environment, not an inherent Searchgres limit.
Searchgres can use any caller-supplied AI SDK embedding model, including a remote
provider or a GPU-backed local service.

For orientation, one Apple Silicon arm64 run using a Podman VM with about 3.8 GB
of memory imported 500 short records in 0.10 seconds. The asynchronous worker,
configured in batches of 100, made all 500 semantically searchable in 14.7
seconds—about 34 embeddings per second. Once embedded, BM25, semantic, and hybrid
queries each completed in roughly 46–60 ms. Records are available to filters and
BM25 immediately while their embeddings are generated in the background.

These numbers are illustrative rather than a benchmark guarantee: CPU model,
VM resources, record length, cold starts, and host load all matter. Hundreds of
short records should be comfortable for evaluation; use a production embedding
provider or a GPU-backed service when ingestion throughput is important.

Ollama may log that the requested 8,192-token context exceeds
`n_ctx_train=2048` for this model. Nomic v1.5 has a 2,048-token base context in
its GGUF metadata and extends to 8,192 tokens with RoPE. Ollama's packaged
Modelfile sets `num_ctx 8192` and applies that model-level override, while the
runner warning still reports the base GGUF/training metadata. The warning is
therefore Ollama-specific and does not indicate that Searchgres has a 2,048-token
context limit.

## Install

Install the latest release of all three compiled executables:

```bash
curl -fsSL https://raw.githubusercontent.com/timescale/searchgres/main/install.sh | sh
```

The installer downloads `searchgres`, `searchgres-server`, and
`searchgres-mcp` for the current OS and architecture, then verifies each release
checksum. It installs into `~/.local/bin` when that directory or its parent
exists, otherwise `~/bin`. Set `SEARCHGRES_INSTALL_DIR` to choose another
location.

For the runtime-agnostic TypeScript library:

```bash
npm install searchgres postgres @ai-sdk/openai   # or any AI SDK provider
```

## Quick start

```ts
import postgres from "postgres";
import { createIndex, openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const sql = postgres(process.env.DATABASE_URL);

// Create an index (its own Postgres schema). dimensions must match your model.
await createIndex(sql, "docs_index", { dimensions: 1536 });

// Open it, supplying the embedding model.
const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

// Write records.
await index.upsertMany([
  { content: "Auth tokens rotate every 24 hours.", tree: "docs.auth" },
  { content: "Rate limits are 100 req/min per API key.", tree: "docs.api" },
]);

// Generate their embeddings (in production, run a worker instead).
await index.processEmbeddings();

// Search: semantic, keyword, or — passing both arms — hybrid.
const hits = await index.search({
  semantic: "how are request limits enforced?",
  fulltext: "rate limit",
  limit: 5,
});

for (const hit of hits) console.log(hit.score, hit.tree, hit.content);

await sql.end();
```

Full walkthrough: **[Get started](docs/getting-started.md)**.

## Product surfaces

Compiled binaries layer remote workflows over the same core:

- `searchgres-server` provisions and serves one configured index.
- `searchgres` provides records, trees, import/export, and search over HTTP.
- `searchgres-mcp` exposes twelve MCP tools over stdio. It talks only to `searchgres-server`,
  registers all tools by default, and accepts `--read-only` to omit mutations.

Generate server files offline, review them, and then initialize PostgreSQL:

```bash
searchgres-server config
searchgres-server init --config searchgres.yaml
searchgres-server serve --config searchgres.yaml
```

Use `init --if-not-exists` for strict idempotent provisioning: an existing index
is accepted only when it is a valid, shape-compatible Searchgres index. See the
[API server guide](docs/guides/server.md).

The MCP binary requires only `--server <url>` or `SEARCHGRES_URL`; it does not
read server config, dotenv, database credentials, or local import/export files.
See the [MCP server guide](docs/mcp/index.md).

## Documentation

- [Get started](docs/getting-started.md)
- [Install searchgres](docs/installation.md)
- [Create and manage indexes](docs/guides/indexes.md)
- [Ingest records](docs/guides/ingest.md)
- [Generate embeddings](docs/guides/embeddings.md)
- [Search and filter](docs/guides/search.md)
- [Manage records and trees](docs/guides/records-and-trees.md)
- [Configure and run the API server](docs/guides/server.md)
- [Evaluate with Docker Compose](docs/guides/docker-compose.md)
- [Run in production](docs/guides/production.md)
- [Use the MCP server](docs/mcp/index.md)
- [API reference](docs/reference/api.md) ·
  [Errors](docs/reference/errors.md) ·
  [Direct SQL](docs/reference/sql.md)

## License

[Apache 2.0](LICENSE)

searchgres is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See [NOTICE](NOTICE).
