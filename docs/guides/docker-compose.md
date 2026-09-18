# Evaluate with Docker Compose

The core library is the product; this optional stack makes it easy to try the
compiled CLI and MCP without a provider account. It runs PostgreSQL 18 with
required extensions, Ollama, a model-pull job, strict index initialization, and
one continuous embedding worker. There is no searchgres.js HTTP service.

**Evaluation only:** PostgreSQL uses trust authentication and a privileged role;
Ollama is unauthenticated. Both publish only on `127.0.0.1`. Do not expose them
to untrusted networks or treat this as production deployment guidance.

## Start and use from the host

Requirements: Docker with Compose 2.20+ and sufficient memory/disk for PostgreSQL
and the Ollama model. Ollama is CPU-only in this example; initial model pull and
cold inference can take time.

```sh
git clone https://github.com/timescale/searchgres-js.git
cd searchgres-js
./bun install
./bun run compile
docker compose up -d --build
# Wait for the one-shot jobs; up -d alone does not mean the model/index is ready.
docker compose wait model init

./dist/searchgres --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample info
./dist/searchgres --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample create \
  --content 'Postgres indexes make database queries faster' --tree docs.db
./dist/searchgres --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample search --fulltext database
./dist/searchgres --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample search \
  --semantic 'speed up database queries' --fulltext database
```

Wait for `embeddings status`/`get` to show generated vectors before expecting
semantic record matches. The host CLI must also reach Ollama to embed **query
text**, even when all stored vectors are already present.

To use MCP:

```sh
./dist/searchgres mcp --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample --workers 0
```

Zero avoids adding workers beyond Compose's worker; omit it to use MCP's default
one-worker pool. Both choices are concurrency-safe. See [MCP setup](../mcp/index.md).

## Services and configuration

| Service | Purpose |
| --- | --- |
| `db` | PostgreSQL, required extensions, named data volume. |
| `ollama` | OpenAI-compatible endpoint, named model volume. |
| `model` | Idempotent pull of `nomic-embed-text`. |
| `init` | `searchgres init --if-not-exists`; waits for healthy DB, does not need Ollama. |
| `worker` | `searchgres embeddings worker`; waits for successful model/init jobs. |

`init` and `worker` use the same single-binary image and mount the same config
read-only. Host commands use that same config with environment-selected URLs:

| Endpoint | Host | Containers |
| --- | --- | --- |
| PostgreSQL | `postgresql://postgres@127.0.0.1:5432/postgres` | `postgresql://postgres@db:5432/postgres` |
| Embeddings | `http://127.0.0.1:11434/v1` | `http://ollama:11434/v1` |

The host environment sample contains no secrets. No generated config or `.env`
is required. Compose explicitly sets container endpoint values. Config files do
not perform arbitrary environment interpolation: `urlEnv`/`baseUrlEnv` are
explicit references.

Override host ports with `SEARCHGRES_POSTGRES_PORT` and `SEARCHGRES_OLLAMA_PORT`:

```sh
SEARCHGRES_POSTGRES_PORT=55432 SEARCHGRES_OLLAMA_PORT=11435 docker compose up -d
```

Then set matching `SEARCHGRES_DATABASE_URL` and
`SEARCHGRES_EMBEDDING_BASE_URL` for host commands. Existing environment values
win over `.env.sample`. Keep model, dimensions, and tokenizer policy consistent
across all generators/readers; changing a model name is not a safe migration of
existing vectors.

## Dependencies only and lifecycle

```sh
docker compose up -d db                 # PostgreSQL-only exploration
docker compose up -d db ollama model    # dependencies for host workers
```

When selecting dependencies only, run `searchgres init` and embedding processing
from the host. Normal full-text/filter operations do not require provider I/O.

`docker compose down` preserves database/model volumes. `docker compose down -v`
is an explicit destructive reset. Worker restart is bounded to three
on-failure restarts. Worker shutdown has a 60-second application grace and a
70-second Compose stop grace; abandoned claims recover through core leases.

Inspect progress with `docker compose logs model init worker` and
`searchgres embeddings status`. The worker's existence is not proof that every
row has an embedding or that the provider is healthy.

## Verification

```sh
./bun run check:compose
./bun run test:compose  # opt-in: builds/pulls images and a real model
```

The smoke test uses a unique project and ephemeral loopback host ports, exercises
the compiled host CLI for all search arms, verifies container-worker and
host-worker embedding, restarts with preserved volumes, checks idempotent init,
and always removes its own volumes. CI also validates topology and builds the
single-binary image from the clean Docker context.
