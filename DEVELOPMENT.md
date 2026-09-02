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
`@searchgres/filter`, `@searchgres/presentation`, and `@searchgres/client` must
run on Node, Bun, and Deno:
Biome bans the `Bun`/`Deno`
globals and Bun-only/Deno-only specifiers there, and CI installs the packed
tarball into a scratch project and imports it by package name under all three
runtimes. Only `@searchgres/server`, `@searchgres/cli`, and `@searchgres/mcp` may use
`Bun.*`, and they ship as compiled binaries rather than as importable source.

## Workspace layout

| Package | Responsibility |
| --- | --- |
| `packages/core` | Runtime-agnostic Postgres search library; published as `searchgres`. |
| `packages/protocol` | Runtime-neutral Zod RPC contract/OpenRPC source. |
| `packages/filter` | Private runtime-neutral parser for the `searchgres` filter-expression DSL. |
| `packages/presentation` | Private runtime-neutral record selector/projector shared by CLI and MCP. |
| `packages/client` | Runtime-agnostic fetch JSON-RPC client. |
| `packages/server` | Bun server component and the `searchgres-server` binary: config, RPC service, providers, tokenizer pool, worker lifecycle, provisioning. |
| `packages/cli` | Bun-only `searchgres` binary: the unprivileged client, including import/export and its own flag/format helpers. It shares no code with `searchgres-server`. |
| `packages/mcp` | Bun-only `searchgres-mcp` stdio server: twelve agent tools over the remote client. |

Dependency direction is intentionally one-way: CLI uses
client/filter/presentation/protocol; MCP uses client/presentation/protocol;
presentation, filter, and client use protocol; server uses core/protocol. CLI
and MCP never import server or core. Core, protocol, filter, presentation, and
client must not use Bun APIs.

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
./bun run test:db                          # build, compile all three binaries, run all suites
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
installation or runtime. The DSL's executable language examples live in
`packages/filter/test/cases.yaml`: each case contains an expression and exactly
one expected protocol result or structured error. The Node test harness loads
that conformance file with the development-only `yaml` package. Keep generated
limit and diagnostic-mechanics tests in TypeScript rather than encoding huge or
programmatically constructed inputs in YAML.

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

There are three, and the split is load-bearing:

| Binary | Package | Commands | Needs |
| --- | --- | --- | --- |
| `searchgres` | `packages/cli` | records, trees, search | `fetch` only |
| `searchgres-server` | `packages/server` | `config`, `init`, `serve`, `destroy` | PostgreSQL, core, provider credentials |
| `searchgres-mcp` | `packages/mcp` | twelve MCP tools over stdio | `fetch`, MCP SDK |

`bun build --compile` initializes a binary's entire module graph at startup
whether a command uses it or not — a lazy `import()` does **not** defer it. A
single binary therefore made every `searchgres search` pay for postgres, the
embedding provider, and the prompt library: 68ms versus 20ms for the client
alone. Keeping that code unreachable from `searchgres`'s entry point is the only
mechanism that works, so **do not import `searchgres`, `postgres`,
`@searchgres/server`, or `@clack/prompts` from `packages/cli/src`.**

**The client binaries never import the server or each other.**
`searchgres-server` owns a config file, a `.env`, and database and provider
credentials; `searchgres` knows only a server URL (`--server` or
`SEARCHGRES_URL`). Each binary package therefore keeps its own shell-facing
helpers. Reusable runtime-neutral semantics belong in focused packages:
selection and projection live only in `@searchgres/presentation`. Biome prevents
MCP from importing CLI, server, core, or postgres and prevents CLI/server
coupling.

Build all three for the current host:

```sh
./bun run compile
./dist/searchgres --help
./dist/searchgres-server --help
./dist/searchgres-mcp --help
```

Build every release target (Linux/Windows/macOS, amd64 and arm64):

```sh
./bun run compile:all
```

These root `dist/` filenames are the release contract consumed by `install.sh`.
A GitHub release must attach every platform binary plus a sibling
`<asset>.sha256` containing its SHA-256 digest. The installer downloads and
verifies all three matching executables before moving any into place. Its local
HTTP fixture tests run as part of `test:unit`.

On macOS, both commands replace Bun's signature with an ad-hoc signature carrying
`scripts/macos-entitlements.plist`; `compile:all` does this for both macOS
architectures before calculating their checksums. This makes local binaries
immediately runnable and testable. Builds on other operating systems cannot run
Apple's `codesign`, so the installer retains the same signing step as a fallback
for downloaded macOS artifacts. To inspect a local build:

```sh
codesign --verify --strict dist/searchgres
codesign -d --entitlements :- dist/searchgres
```

The root build bundles the tokenizer worker first because `searchgres-server`
embeds it. Package-local `dist/` directories contain compiled JavaScript and
type declarations; the three native executables live only in the root `dist/`
directory. Root compile commands clear that directory first so stale platform
artifacts cannot mask failures.

## Local setup

Generate a reviewable server config and environment-file template without
connecting to PostgreSQL or the embedding provider:

```sh
./dist/searchgres-server config
```

Or supply explicit noninteractive arguments:

```sh
./dist/searchgres-server config \
  --config searchgres.yaml \
  --database-url-env SEARCHGRES_DATABASE_URL \
  --schema docs \
  --embedding-model text-embedding-3-small \
  --dimensions 1536 \
  --vector-type halfvec
```

After reviewing the generated files, initialize the configured database schema
and start the server:

```sh
./dist/searchgres-server init --config searchgres.yaml
./dist/searchgres-server serve --config searchgres.yaml
```

Use `init --if-not-exists` in idempotent automation. It accepts only an existing
valid Searchgres index whose vector type and dimensions match the config; it
never ignores malformed, incompatible, or ordinary same-named schemas.

`init`, `serve`, and `destroy` load a `.env` next to the config by default without
overwriting already-set process environment variables. Use
`--env-file <path>` or `--no-env-file` to control that behavior.

Use `--read-only` for a query-only server: it rejects mutation RPC methods and
does not start the embedding worker, while semantic search still embeds query
text on demand.

## `.env` handling

The interactive `searchgres-server config` wizard can generate a `.env`, so this
repository owns both halves of the format. There is no dependency for it,
deliberately:

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

The current `compose.yaml` still uses profiles until the evaluation-stack
redesign lands. Generate files first, then initialize from the reviewed config:

```sh
# 1. Start PostgreSQL.
docker compose up -d db

# 2. Generate config locally through the tools image. Choose host 0.0.0.0.
docker compose --profile tools run --rm cli config

# 3. Initialize that exact config in PostgreSQL.
docker compose --profile tools run --rm cli init \
  --config searchgres.yaml --if-not-exists

# 4. Start the server.
docker compose --profile server up -d server
```

The tools container defaults `SEARCHGRES_DATABASE_URL` to
`postgresql://postgres@db:5432/postgres`. This profile-based workflow is an
interim development path; the planned evaluation Compose stack will replace it
with a checked-in config, local Ollama model, and ordinary one-command
`docker compose up`.

## Generated files

`packages/server/scripts/bundle-tokenizer-worker.ts` generates
`packages/server/src/tokenizer.worker.generated.cjs`. It is ignored and must not
be edited manually. Build/typecheck scripts regenerate it as needed.

Never commit `dist/`, `.env`, credentials, or generated tokenizer-worker source.
