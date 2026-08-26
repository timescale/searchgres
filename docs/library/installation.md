# Installation

## Runtime requirements

- PostgreSQL 18
- Node 22 or newer, Bun 1.2 or newer, or Deno 2 or newer
- `pgvector`, `pg_textsearch`, and `ltree`

`pg_textsearch` must be present in PostgreSQL's preload configuration before the
server starts:

```conf
shared_preload_libraries = 'pg_textsearch'
```

The repository Docker image provides PostgreSQL 18 with all three extensions for
local development and tests.

## Packages

Install the core package, the postgres.js driver, and the provider package your
application uses:

```bash
npm install searchgres postgres @ai-sdk/openai
```

`searchgres` depends on the provider-agnostic `ai` package. It does not depend on
any `@ai-sdk/*` provider package; your application chooses and configures one.

## Pool ownership

Create and close the postgres.js pool in your application:

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, {
  max: 10,
  onnotice: () => {},
});

try {
  // Pass sql to searchgres calls.
} finally {
  await sql.end();
}
```

searchgres does not create, close, or persistently mutate this pool.
