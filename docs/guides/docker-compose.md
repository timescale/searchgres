# Evaluate Searchgres with Docker Compose

The repository's root `compose.yaml` is a one-command **evaluation and local-demo
stack**, not a production deployment. It runs PostgreSQL, a local embedding
model, automatic model download and index provisioning, and the Searchgres API.
No provider account, API key, generated config, or locally installed Searchgres
binary is required.

## Requirements

- Docker Engine or Docker Desktop
- Docker Compose **2.20.0 or newer** (for health and one-shot dependency
  conditions)
- Several gigabytes of free disk space and at least 4 GB of available memory

The pinned CPU-only Ollama image is several gigabytes unpacked, and
`nomic-embed-text` adds roughly 275 MB. A cold first start downloads images and
the model and may take several minutes. Later starts reuse named volumes.

## Start the stack

From a repository checkout:

```sh
docker compose up --build
```

Compose starts five services:

| Service | Purpose | Completion condition |
| --- | --- | --- |
| `db` | PostgreSQL 18 with pgvector, pg_textsearch, and ltree | healthy |
| `ollama` | CPU-only local embedding endpoint | healthy |
| `model-pull` | Downloads `nomic-embed-text` into persistent storage | exits successfully |
| `provision` | Creates or strictly validates the configured index | exits successfully |
| `server` | Runs the Searchgres API and embedding worker | healthy |

Model download progress is visible in the ordinary Compose output. Searchgres is
ready when the `server` service is healthy, at:

```text
http://127.0.0.1:3000
```

Only that loopback API port is published. PostgreSQL and Ollama remain on the
internal Compose network.

## Try it

The server image includes the unprivileged `searchgres` client:

```sh
docker compose exec server \
  searchgres --server http://127.0.0.1:3000 info

docker compose exec server \
  searchgres --server http://127.0.0.1:3000 create \
  --content "Postgres-native semantic and BM25 search" \
  --tree docs --name introduction

docker compose exec server \
  searchgres --server http://127.0.0.1:3000 search \
  --semantic "database search"

docker compose exec server \
  searchgres --server http://127.0.0.1:3000 search \
  --fulltext "Postgres" --semantic "database search"
```

New records enter an asynchronous embedding queue. The in-process worker normally
embeds them within a few seconds; keyword search is available immediately.

A locally installed client can use the host endpoint instead:

```sh
searchgres --server http://127.0.0.1:3000 info
```

## Restart and reset

Stop and remove containers while preserving the database and model:

```sh
docker compose down
docker compose up
```

The model pull is content-addressed and idempotent. Provisioning uses
`init --if-not-exists`, which accepts only a valid Searchgres index whose vector
shape matches the checked-in config; it does not hide malformed schemas or
configuration drift.

Explicitly delete all evaluation data and the downloaded model:

```sh
docker compose down -v
```

## Inspect failures

The one-shot dependencies deliberately prevent the API from starting if model
pulling or provisioning fails:

```sh
docker compose ps
docker compose logs model-pull
docker compose logs provision
docker compose logs db ollama server
```

There are no retry loops hiding permanent model, schema, or extension failures.
After correcting a failure, run `docker compose up` again. Use `down -v` only
when you intentionally want a clean database and model store.

For database-only development:

```sh
docker compose up -d db
docker compose exec db psql -U postgres -d postgres
```

Port 5432 is intentionally not published by the default stack.

## Configuration and model

Both provisioning and serving mount
`docker/evaluation/searchgres.yaml` read-only. It configures:

- schema `searchgres`;
- `halfvec(768)` storage;
- Ollama's OpenAI-compatible endpoint at `http://ollama:11434/v1`;
- `nomic-embed-text` with its 8,192-token Nomic tokenizer preset;
- a continuous embedding worker.

The stack pins `ollama/ollama:0.15.4`, which publishes upstream amd64 and arm64
images. Ollama is MIT-licensed, and the downloaded Nomic model reports the
Apache-2.0 license. The default is CPU-only for portability; GPU-specific
Compose configuration is intentionally out of scope.

## Not for production

The evaluation stack deliberately trades hardening for a reliable first run:

- PostgreSQL uses trust authentication, and its role can install extensions and
  create schemas.
- Searchgres v1 has no built-in authentication.
- Ollama is CPU-only and not tuned for production throughput.
- There is no TLS termination, backup policy, resource limit, or observability
  backend.

The API is loopback-bound to reduce accidental exposure, but this is not a
production security architecture. Production operators should provide managed
credentials, TLS and network policy, backups, resource controls, observability,
and an independently managed embedding provider. Ollama is an evaluation choice,
not a Searchgres core or server requirement.

## Full smoke test

Maintainers can run the opt-in real-model test:

```sh
./bun run test:compose
```

It uses a unique Compose project, starts from fresh volumes, creates and embeds
two records, checks semantic/BM25/hybrid search, restarts without deleting state,
verifies strict provisioning idempotency and persistence, and always removes its
containers and volumes. It is intentionally manual because the image and model
download are much heavier than ordinary unit tests. Maintainers should also run
the manual **Evaluation Compose smoke** GitHub Actions workflow as the Linux
amd64 release gate.
