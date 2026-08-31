# Install searchgres

## Packages

```bash
npm install searchgres postgres
```

`searchgres` uses the [`postgres.js`](https://github.com/porsager/postgres)
driver (a peer you install alongside it) and the provider-agnostic
[`ai`](https://sdk.vercel.ai) package. It does **not** depend on any specific
provider package — you choose and install one:

```bash
npm install @ai-sdk/openai   # or @ai-sdk/mistral, @ai-sdk/google, ...
```

## Runtime support

searchgres is runtime-agnostic and ships as ESM with type declarations:

- Node 22 or newer
- Bun 1.2 or newer
- Deno 2 or newer

## PostgreSQL

searchgres targets **PostgreSQL 18** and requires three extensions:

| Extension | Provides | Minimum version |
| --- | --- | --- |
| [`pgvector`](https://github.com/pgvector/pgvector) | `vector` / `halfvec` columns and HNSW cosine indexes | 0.8.0 |
| [`pg_textsearch`](https://github.com/timescale/pg_textsearch) | BM25 index and ranking | 1.4.0 |
| `ltree` | hierarchical tree paths (ships with PostgreSQL) | 1.3.0 |

Two requirements are worth calling out up front:

- **`pg_textsearch` must be preloaded.** It uses a shared library that has to be
  configured before the server starts:

  ```conf
  shared_preload_libraries = 'pg_textsearch'
  ```

- **The extensions must live in the `public` schema.** searchgres is opinionated
  here to keep every reference unambiguous. `createIndex()` installs any missing
  extension into `public`; if one already exists in another schema it fails with
  an [`ExtensionError`](reference/errors.md) rather than moving it.

### Privileges

The role you use with `createIndex()` needs to:

- run `CREATE EXTENSION` the first time an extension is missing, and
- create schemas and objects.

If your database restricts extension creation, pre-install the three extensions
in `public` as a superuser; `createIndex()` then only needs schema/object
creation rights.

## Local setup with Docker

The repository includes a Dockerfile that builds PostgreSQL 18 with all three
extensions and the required preload configuration.

```bash
# Build the image
docker build -t searchgres-postgres -f docker/Dockerfile.postgres docker/

# Run it (trust auth for local development only)
docker run -d --name searchgres-postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:5432:5432 \
  searchgres-postgres
```

Verify the extensions are available:

```bash
psql postgres://postgres@127.0.0.1:5432/postgres -c \
  "select name, default_version from pg_available_extensions
   where name in ('vector','pg_textsearch','ltree') order by name;"
```

## You own the connection pool

searchgres never creates, closes, or persistently reconfigures a connection.
Create the pool, pass it in, and close it yourself:

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 10 });

try {
  // pass `sql` to createIndex/openIndex and index methods
} finally {
  await sql.end();
}
```

You can point separate pools at different databases and run independent indexes
across them — see [Create and manage indexes](guides/indexes.md).

Next: [Get started](getting-started.md).
