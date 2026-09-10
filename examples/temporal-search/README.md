# Temporal search

Stores a point event and a validity period in a temporary
`example_temporal_<random>` index, then searches by represented time. `temporal`
is distinct from record creation/update time. The temporary index is removed in
`finally`, so the example is safe to run repeatedly.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```
