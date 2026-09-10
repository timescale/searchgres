# Configure and run the reference API server

`searchgres-server` is a maintained reference implementation showing one way to
host the core library for a single index. It is optional and does not define how
applications must expose searchgres.

## Security boundary

> **Warning:** the reference server has no built-in authentication,
> authorization, TLS termination, or rate limiting. Keep it bound to loopback,
> or place it behind an application or trusted proxy that supplies those
> controls. Do not expose it directly to an untrusted network.

Anyone who can reach a writable server can mutate its configured index. Anyone
who can reach a read-only server can query its records and can trigger
embedding-provider calls through semantic search. `--read-only` reduces
capabilities; it is not authentication. Likewise, `--allow-public-listen` only
acknowledges an unauthenticated non-loopback binding—it does not secure it.

The server is a privileged *process* because it owns the PostgreSQL connection,
embedding-provider configuration, index provisioning, background embedding
worker, and HTTP API. That does not make it an authenticated privilege boundary.
The reference `searchgres` CLI, internal client workspace, and `searchgres-mcp`
binary never read these credentials or this config, but they do not add network
authentication either.

> Looking for a no-API-key local demo? The checked-in
> [Docker Compose evaluation stack](docker-compose.md) configures PostgreSQL,
> Ollama, provisioning, and this server automatically. This guide covers
> managing your own server configuration and provider.

## 1. Generate configuration offline

Run the interactive generator:

```sh
searchgres-server config
```

This writes a YAML or JSON5 server config, a `.env.example`, and a `.gitignore`
entry for the real `.env`. It does not connect to PostgreSQL or the embedding
provider, so you can generate and review the files before either service is
running.

For automation, provide the values explicitly:

```sh
searchgres-server config \
  --config searchgres.yaml \
  --database-url-env SEARCHGRES_DATABASE_URL \
  --schema docs \
  --embedding-model text-embedding-3-small \
  --dimensions 1536 \
  --vector-type halfvec \
  --api-key-env SEARCHGRES_EMBEDDING_API_KEY
```

Use `--base-url` for an OpenAI-compatible endpoint. `--dry-run` prints the
rendered config without creating any files. Existing config files are never
overwritten implicitly.

### Complete minimal config

This is the smallest practical OpenAI configuration. Omitted settings take the
defaults listed in the full reference below.

```yaml
version: 1
server: {}
database:
  urlEnv: SEARCHGRES_DATABASE_URL
index:
  schema: docs
  dimensions: 1536
  vectorType: halfvec
  embedding:
    provider: openai-compatible
    model: text-embedding-3-small
    apiKeyEnv: SEARCHGRES_EMBEDDING_API_KEY
```

### Full annotated config reference

The parser rejects unknown fields. Durations are nonnegative integers followed
by `ms`, `s`, `m`, `h`, or `d`; for example, `30s` or `5m`.

```yaml
version: 1                         # required config-file format

server:
  listen:
    host: 127.0.0.1               # default; see the security warning above
    port: 3000                    # default; 1..65535
  maxRequestBodyBytes: 1048576    # default; positive integer

database:
  urlEnv: SEARCHGRES_DATABASE_URL # required; PostgreSQL URL is read from here
  api:                            # request-serving postgres.js connections
    pool:
      max: 20                     # default; at least 1
      idleReap: 5m                # default idle-connection timeout
      maxLifetime: 0s             # default; 0 disables lifetime expiry
      connectTimeout: 30s         # default connection timeout
    session:
      statementTimeout: 30s       # PostgreSQL statement_timeout
      lockTimeout: 5s             # PostgreSQL lock_timeout
      transactionTimeout: 35s     # PostgreSQL 18 transaction_timeout
      idleInTransactionSessionTimeout: 35s
  worker:                         # separate embedding-worker connections
    pool:
      max: 2
      idleReap: 5m
      maxLifetime: 0s
      connectTimeout: 30s
    session:
      statementTimeout: 25s
      lockTimeout: 5s
      transactionTimeout: 30s
      idleInTransactionSessionTimeout: 30s

index:
  schema: docs                    # literal Searchgres PostgreSQL schema
  dimensions: 1536                # 1..2000 vector; 1..4000 halfvec
  vectorType: halfvec             # vector or halfvec
  embedding:
    provider: openai-compatible   # only supported reference-server provider
    model: text-embedding-3-small # provider model identifier
    baseUrl: https://api.openai.com/v1 # optional absolute URL
    apiKeyEnv: SEARCHGRES_EMBEDDING_API_KEY # optional for keyless local APIs
  truncate:
    kind: none                    # default; alternatives are described below
  worker:
    interval: 1s                  # default delay between drain passes
    batchSize: 100                # default; integer 1..1000
```

`index.truncate` accepts exactly one of these shapes:

| Policy | Configuration |
| --- | --- |
| No truncation (default) | `{ kind: none }` |
| Unicode characters | `{ kind: characters, max: <positive integer> }` |
| UTF-8 bytes | `{ kind: bytes, max: <positive integer> }` |
| Exact token budget | `{ kind: tokens, tokenizer: <preset>, maxTokens: <positive integer>, threads?: 0..64 }` |

Token presets are `openai-cl100k-base`, `nomic-embed-text-v1.5`, and
`nomic-modernbert-embed-base`. `threads: 0` runs tokenization inline; omitting it
uses the tokenizer pool's default concurrency.

Environment references must match `[A-Za-z_][A-Za-z0-9_]*`. The names are
caller-selected—`SEARCHGRES_DATABASE_URL` and
`SEARCHGRES_EMBEDDING_API_KEY` are conventions, not magic variables. The config
stores only those names. `database.urlEnv` is required by all database commands;
`index.embedding.apiKeyEnv` is read only while serving and may be omitted for a
keyless OpenAI-compatible endpoint.

### Creation settings and runtime settings

| Fields | How the server uses them |
| --- | --- |
| `version` | Selects the server-config parser. It is separate from the immutable database schema format. |
| `index.schema`, `index.dimensions`, `index.vectorType` | `init` uses them to create the index. Once created, PostgreSQL is authoritative; `init --if-not-exists` and `serve` reject schema-format or vector-shape mismatches. |
| `index.embedding` | Runtime provider construction. Model identity is not persisted in PostgreSQL or compared on open; changing it requires re-embedding existing records. `init` does not call the provider or read its API key. |
| `index.truncate` | Runtime policy applied before provider calls. It is not persisted. |
| `index.worker` | Runtime continuous-worker tuning; ignored by `serve --read-only`. |
| `server.*` | HTTP listener and request-body behavior for `serve`; not used by provisioning. |
| `database.api`, `database.worker` | Runtime pool/session behavior for `serve`. Provisioning and destruction use a single short-lived connection. |

The server owns one configured index. To serve another index or database, run a
separate server configuration and process.

## 2. Review credentials

The config stores environment-variable names, never raw database or provider
credentials. Copy or populate the generated `.env.example` as `.env`:

```dotenv
SEARCHGRES_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres
SEARCHGRES_EMBEDDING_API_KEY=replace-me
```

An embedding API key is optional for local OpenAI-compatible providers that do
not require one.

## 3. Initialize PostgreSQL

After reviewing the files and starting PostgreSQL:

```sh
searchgres-server init --config searchgres.yaml
```

`init` only provisions the database. It never edits the config or environment
files, and it does not contact the embedding provider or require its API key.
The configured database role must be able to install missing required extensions
in `public` and create the index schema.

For containers and other repeatable automation:

```sh
searchgres-server init --config searchgres.yaml --if-not-exists
```

`--if-not-exists` is deliberately strict:

- It creates a missing index.
- It accepts an existing valid Searchgres index only when dimensions and vector
  type match the config.
- It fails for an unsupported schema format, shape mismatch, misplaced/missing
  extension, or ordinary same-named PostgreSQL schema.

It never rebuilds, migrates, replaces, or deletes an existing schema.

## 4. Serve

```sh
searchgres-server serve --config searchgres.yaml
```

The server validates the configured shape before opening its HTTP listener. It
then starts the embedding worker unless `--read-only` is supplied:

```sh
searchgres-server serve --config searchgres.yaml --read-only
```

Read-only mode rejects mutating RPC methods and does not drain record embedding
work. Semantic queries can still call the configured embedding provider.

### HTTP endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /rpc` | JSON-RPC 2.0 requests for the reference search API. |
| `GET /openrpc.json` | Generated OpenRPC description of every RPC method and schema. |
| `GET /healthz` | Process liveness after the HTTP listener has started. |
| `GET /readyz` | Listener readiness after configuration and index opening succeeded. |

The generated OpenRPC document is the authoritative wire-method reference. Read
it directly or request the same document through `rpc.discover`:

```sh
curl http://127.0.0.1:3000/openrpc.json

curl http://127.0.0.1:3000/rpc \
  --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"1","method":"rpc.discover"}'
```

For the reference CLI's available operations and flags, run
`searchgres --help` and `searchgres <command> --help`. For component roles and
packaging boundaries, see
[Reference implementations and evaluation tools](../reference-applications.md).

## 5. Environment-file precedence

`init`, `serve`, and `destroy` use the same rules:

1. Existing process environment variables have highest precedence.
2. Otherwise, the command loads `.env` beside the absolute config path.
3. `--env-file <path>` selects another file.
4. `--no-env-file` disables dotenv loading.

`--env-file` and `--no-env-file` cannot be combined. Missing default dotenv
files are allowed; missing required variables are reported by name.

## 6. Destroy

Dropping an index is explicit and destructive:

```sh
searchgres-server destroy --config searchgres.yaml --yes
```

It loads environment variables using the same rules and drops only the literal
schema named by that config.

## Config migration during pre-release development

Server configs created before dimensions and vector type became required must be
updated manually:

```yaml
index:
  schema: docs
  dimensions: 1536   # must match the existing embedding column typmod
  vectorType: halfvec # must match the existing HNSW opclass
```

The server intentionally does not guess these values or silently rewrite the
file. If uncertain, inspect the database objects or regenerate a config with
`searchgres-server config`, then review it before use.
