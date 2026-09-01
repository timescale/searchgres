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

Bun is the development toolchain only. `searchgres`, `@searchgres/protocol`,
`@searchgres/filter`, and `@searchgres/client` must run on Node, Bun, and Deno:
Biome bans the `Bun`/`Deno`
globals and Bun-only/Deno-only specifiers there, and CI installs the packed
tarball into a scratch project and imports it by package name under all three
runtimes. Only `@searchgres/server` and `@searchgres/cli` may use `Bun.*`, and
they ship as compiled binaries rather than as importable source.

## Workspace layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Runtime-agnostic Postgres search library; published as `searchgres`. |
| `packages/protocol` | Runtime-neutral Zod RPC contract/OpenRPC source. |
| `packages/filter` | Private runtime-neutral parser for the `sg` filter-expression DSL. |
| `packages/client` | Runtime-agnostic fetch JSON-RPC client. |
| `packages/server` | Bun server component and the `sg-server` binary: config, RPC service, providers, tokenizer pool, worker lifecycle, provisioning. |
| `packages/cli` | Bun-only `sg` binary: the unprivileged client, including import/export and its own flag/format helpers. It shares no code with `sg-server`. |

Dependency direction is intentionally one-way: CLI uses client/filter/protocol;
filter and client use protocol; server uses core/protocol. The CLI never imports
server or core. Core, protocol, filter, and client must not use Bun APIs.

## Checks and tests

```sh
./bun run check        # typecheck, lint, unit tests — no Docker needed
./bun run check:full   # everything CI runs, database included
```

`check:full` is the pre-push gate. It runs the same scripts CI runs, including a
freshness check for the generated filter railroad diagrams, and manages its own
throwaway database via `scripts/with-postgres.ts` — the one place the
container lifecycle is defined, shared with CI so the two cannot drift.

Against a database you manage yourself:

```sh
./bun run pg:up                            # build + start PostgreSQL 18
./bun run test:db                          # build, compile both binaries, run all suites
./bun run --filter searchgres test:db      # just the core suite
./bun run --filter @searchgres/server test:db   # just the compiled-server suite
./bun run pg:rm
```

The filter DSL's authoritative ISO/IEC 14977 grammar and generated railroad
reference are updated with:

```sh
./bun run generate:filter-grammar
./bun run check:filter-grammar
```

`ebnf2railroad` is development-only; grammar generation is never part of package
installation or runtime.

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

## Building the binaries

There are two, and the split is load-bearing:

| Binary | Package | Commands | Needs |
| --- | --- | --- | --- |
| `sg` | `packages/cli` | records, trees, search | `fetch` only |
| `sg-server` | `packages/server` | `init`, `serve`, `destroy` | PostgreSQL, core, provider credentials |

`bun build --compile` initializes a binary's entire module graph at startup
whether a command uses it or not — a lazy `import()` does **not** defer it. A
single binary therefore made every `sg search` pay for postgres, the embedding
provider, and the prompt library: 68ms versus 20ms for the client alone. Keeping
that code unreachable from `sg`'s entry point is the only mechanism that works,
so **do not import `searchgres`, `postgres`, `@searchgres/server`, or
`@clack/prompts` from `packages/cli/src`.**

**The two binaries share no code, in either direction.** `sg-server` owns a
config file, a `.env`, and database and provider credentials; `sg` knows only a
server URL (`--server` or `SEARCHGRES_URL`). Each package therefore keeps its own
flag helpers — a few one-line validators duplicated is cheaper than a dependency
edge between the privileged and unprivileged tools. Biome enforces both
directions, with patterns rather than exact paths so a subpath import cannot slip
through.

Build both for the current host:

```sh
./bun run compile
./packages/cli/dist/sg --help
./packages/server/dist/sg-server --help
```

Build every release target (Linux/Windows/macOS, amd64 and arm64):

```sh
./bun run compile:all
```

Both bundle the tokenizer worker first, because `sg-server` embeds it. Each
binary exists once, at `packages/cli/dist/sg` and
`packages/server/dist/sg-server`; the black-box tests resolve those paths
directly rather than keeping copies.

## Local setup

Interactive bootstrap creates an index, server config, `.env.example`, and (if
credentials are entered) a local `.env`:

```sh
./packages/server/dist/sg-server init
```

Or supply explicit noninteractive arguments:

```sh
SEARCHGRES_DATABASE_URL='postgresql://postgres@127.0.0.1:5432/postgres' \
./packages/server/dist/sg-server init \
  --config searchgres.yaml \
  --database-url-env SEARCHGRES_DATABASE_URL \
  --schema docs \
  --embedding-model text-embedding-3-small \
  --dimensions 1536
```

Start the server:

```sh
./packages/server/dist/sg-server serve --config searchgres.yaml
```

The server loads a `.env` next to its config by default without overwriting
already-set process environment variables. Use `--env-file <path>` or
`--no-env-file` to control that behavior.

Use `--read-only` for a query-only server: it rejects mutation RPC methods and
does not start the embedding worker, while semantic search still embeds query
text on demand.

## `.env` handling

`sg-server init` generates a `.env`, so this repository owns both halves of the
format. There is no dependency for it, deliberately:

- `dotenv` has no writer, so the half where mistakes are costly would stay ours.
- The dialects disagree on the cases that matter. `dotenv` reads `#` as starting
  a comment and truncates there; Docker Compose's `env_file` — our other
  consumer, via `compose.yaml` — takes every character literally and does **not**
  strip quotes.

Because quoting cannot satisfy both (`K="v"` reaches a Compose-deployed server
with literal quotes), `dotenvLine` writes only values that all three readers
agree on and rejects the rest with a message pointing at the environment
variable instead. Rejected: line breaks, `#`, and leading or trailing
whitespace. Everything else — `=`, `:`, `/`, `@`, `?`, `$`, quotes, backslashes,
inner spaces — is written literally and round-trips.

Ordinary connection strings are unaffected: `#` is not legal in a URL outside a
fragment, so `postgres://u:p#w@h/db` is already invalid (`new URL` throws) and
the correct spelling, `postgres://u:p%23w@h/db`, contains no `#` and writes
cleanly. The rejection message says so, rather than sending the user to an
environment variable they do not need.

memory-engine, for comparison, never generated a `.env`: it shipped a
hand-maintained `.env.sample` to copy. We accept the extra responsibility
because one-command setup is worth it, which is why the validation exists.

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
