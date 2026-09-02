# Configure and run the API server

> Looking for a no-API-key local demo? The checked-in
> [Docker Compose evaluation stack](docker-compose.md) configures PostgreSQL,
> Ollama, provisioning, and this server automatically. This guide covers
> managing your own server configuration and provider.

`searchgres-server` is the privileged Searchgres process. It owns the PostgreSQL
connection, embedding-provider configuration, index provisioning, background
embedding worker, and HTTP API. The `searchgres` and `searchgres-mcp` clients never read these
credentials or this config.

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

The config records both the model's expected dimensions and PostgreSQL vector
storage type because they are needed to initialize a fresh database:

```yaml
index:
  schema: docs
  dimensions: 1536
  vectorType: halfvec
  embedding:
    provider: openai-compatible
    model: text-embedding-3-small
    apiKeyEnv: SEARCHGRES_EMBEDDING_API_KEY
```

PostgreSQL remains authoritative once the index exists. The server checks that
its configured dimensions and vector type match the database catalog whenever
it opens the index.

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
