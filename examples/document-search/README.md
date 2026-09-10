# Document search

Demonstrates caller-controlled records for source chunks and a derived summary.
Both representations live in one temporary `example_documents_<random>` index
and are separated by tree and metadata rather than by a hidden extraction
pipeline. The example removes that temporary index in `finally`, so repeated and
failed runs do not leave conflicting schemas behind.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```
