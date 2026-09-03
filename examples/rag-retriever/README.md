# RAG retriever

Shows a small application-owned RAG retrieval stage. It creates `example_rag`,
ingests stable chunks, applies a trusted tenant and visibility scope, and formats
full records as model context.

The example prints context rather than calling a generation model so retrieval
can be inspected independently.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```
