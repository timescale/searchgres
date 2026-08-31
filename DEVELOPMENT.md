# Development

## Requirements

- Node 22.18+ for the Node compatibility tests
- Docker, for PostgreSQL integration tests and Compose development

Bun is not a prerequisite. `./bun` is a wrapper that downloads the pinned Bun
into the git-ignored `download/` directory on first use and execs it, so every
developer and every CI job runs the same version. Use it for **all** repository
tooling, including nested calls inside scripts:

```sh
./bun install
```

To change the Bun version, edit `version=` in `./bun` and the `oven/bun` tag in
`docker/Dockerfile.server`.

Bun is the development toolchain only. `searchgres`, `@searchgres/protocol`, and
`@searchgres/client` must run on Node, Bun, and Deno: Biome bans the `Bun`/`Deno`
globals and Bun-only/Deno-only specifiers there, and CI installs the packed
tarball into a scratch project and imports it by package name under all three
runtimes. Only `@searchgres/server` and `@searchgres/cli` may use `Bun.*`, and
they ship as the compiled `sg` binary rather than as importable source.

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
./bun run check        # typecheck, lint, unit tests — no Docker needed
./bun run check:full   # everything CI runs, database included
```

`check:full` is the pre-push gate. It runs the same scripts CI runs, and manages
its own throwaway database via `scripts/with-postgres.ts` — the one place the
container lifecycle is defined, shared with CI so the two cannot drift.

Against a database you manage yourself:

```sh
./bun run pg:up                            # build + start PostgreSQL 18
./bun run test:db                          # build, compile sg, run all suites
./bun run --filter searchgres test:db      # just the core suite
./bun run --filter @searchgres/server test:db   # just the compiled-server suite
./bun run pg:rm
```

The suites expect PostgreSQL at `TEST_DATABASE_URL`, defaulting to
`postgresql://postgres@127.0.0.1:5432/postgres`. The image includes
PostgreSQL 18, pgvector, pg_textsearch, and ltree.

### How the scripts are organised

Package scripts are single commands that run in their own package and never call
another package. All cross-package sequencing lives in the root `package.json`
as explicit `&&` chains. That ordering is load-bearing: the libraries are
consumed downstream through their built `dist/` and exports map, so they must be
built before the server and CLI are typechecked — which is why the chains are
spelled out rather than using `--filter '*'`. `--filter '*'` respects dependency
*order* but does not stop dependents when a dependency's script fails, turning
one real error into a cascade of misleading ones.

## Building `sg`

Build for the current host:

```sh
./bun run compile
./packages/cli/dist/sg --help
```

Build all release targets:

```sh
./bun run compile:all
```

This creates Linux amd64/arm64, Windows amd64/arm64, and macOS amd64/arm64
binaries under `packages/cli/dist/`.

Both scripts bundle the tokenizer worker first, because the compiled binary
embeds it. There is exactly one `sg` in the repository, at
`packages/cli/dist/sg`; the server's black-box tests resolve that path directly
rather than keeping a copy.

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
