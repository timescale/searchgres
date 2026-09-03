# Basic search

Creates `example_basic`, writes two records, drains embeddings, and performs a
hybrid query scoped by tree and metadata.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```

The example drops its index at the end. Remove that line if you want to inspect
the schema afterward.
