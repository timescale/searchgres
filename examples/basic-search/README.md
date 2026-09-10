# Basic search

Creates a temporary `example_basic_<random>` index, writes two records, drains
embeddings, and performs a hybrid query scoped by tree and metadata.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```

The example drops only the temporary index it created, including after a failed
run, so it is safe to run repeatedly. To inspect the schema, pause before the
`finally` cleanup rather than pointing the example at an existing index.
