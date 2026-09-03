# Separate embedding worker

A process that opens `application_search` and continuously drains its embedding
queue. The application that writes records can run separately without embedding
provider credentials.

Create the index from the writer or provisioning process before starting this
worker.

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
export OPENAI_API_KEY=...
npm install searchgres postgres @ai-sdk/openai
node index.ts
```

Send `SIGINT` or `SIGTERM` for graceful shutdown.
