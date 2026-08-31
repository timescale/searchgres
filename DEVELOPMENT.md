# Development

## Requirements

- Node 22.18+ for TypeScript tooling
- Bun 1.4+
- Docker, for PostgreSQL integration tests and Compose development

Install workspace dependencies:

```sh
npm install
```

## Workspace layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Runtime-agnostic Postgres search library; published as `searchgres`. |
| `packages/protocol` | Runtime-neutral Zod RPC contract/OpenRPC source. |
| `packages/client` | Runtime-agnostic fetch JSON-RPC client. |
| `packages/server` | Bun server component: config, RPC service, providers, tokenizer pool, worker lifecycle. |
| `packages/cli` | Bun-only command router and compiled `sg` binary. |

Dependency direction is intentionally one-way: CLI may use server/client/core;
server uses core/protocol; client uses protocol. Core, protocol, and client must
not use Bun APIs.

## Checks and tests

```sh
npm run check       # typecheck, lint, unit tests
npm run test:db     # build all packages, then database integration tests
```

Run only the compiled-server database test suite:

```sh
npm run test:db --workspace=@searchgres/server
```

The database tests expect PostgreSQL at `TEST_DATABASE_URL`, defaulting to
`postgresql://postgres@127.0.0.1:5432/postgres`.

Start the development PostgreSQL image:

```sh
npm run pg:build
npm run pg:up
# ... run tests ...
npm run pg:rm
```

The image includes PostgreSQL 18, pgvector, pg_textsearch, and ltree.

## Building `sg`

Build for the current host:

```sh
npm run compile --workspace=@searchgres/cli
./packages/cli/dist/sg --help
```

Build all release targets:

```sh
npm run compile:all --workspace=@searchgres/cli
```

This creates Linux amd64/arm64, Windows amd64/arm64, and macOS amd64/arm64
binaries under `packages/cli/dist/`.

`packages/server` retains a `compile` compatibility script for its black-box
tests; the actual binary entrypoint belongs to `packages/cli`.

## Local setup

Interactive bootstrap creates an index, server config, `.env.example`, and (if
credentials are entered) a local `.env`:

```sh
./packages/cli/dist/sg init
```

Or supply explicit noninteractive arguments:

```sh
SEARCHGRES_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/postgres' \
./packages/cli/dist/sg init \
  --config searchgres.yaml \
  --database-url-env SEARCHGRES_DATABASE_URL \
  --schema docs \
  --embedding-model text-embedding-3-small \
  --dimensions 1536
```

Start the server:

```sh
./packages/cli/dist/sg server --config searchgres.yaml
```

The server loads a `.env` next to its config by default without overwriting
already-set process environment variables. Use `--env-file <path>` or
`--no-env-file` to control that behavior.

Use `--read-only` for a query-only server: it rejects mutation RPC methods and
does not start the embedding worker, while semantic search still embeds query
text on demand.

## Docker Compose

`compose.yaml` avoids a bootstrap cycle with profiles: the database starts by
default, while the server starts only with the `server` profile. The `tools`
profile provides `sg` inside the Compose network, so initialization can reach
the database hostname `db` and write config files back to the working directory.

```sh
# 1. Start only PostgreSQL (no config file required).
docker compose up -d db

# 2. Create the index/config interactively. Choose host 0.0.0.0 when prompted.
docker compose --profile tools run --rm cli init

# 3. Start the configured server.
docker compose --profile server up -d server
```

The tools container defaults `SEARCHGRES_DATABASE_URL` to
`postgresql://postgres@db:5432/postgres`. `init` writes `searchgres.yaml` and
optionally `.env` in the project root; the server mounts both. Do not run bare
`docker compose up` expecting the server before initialization.

## Generated files

`packages/server/scripts/bundle-tokenizer-worker.ts` generates
`packages/server/src/tokenizer.worker.generated.cjs`. It is ignored and must not
be edited manually. Build/typecheck scripts regenerate it as needed.

Never commit `dist/`, `.env`, credentials, or generated tokenizer-worker source.
