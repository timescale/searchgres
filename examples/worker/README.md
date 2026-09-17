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

The example reports safe error codes from `onError`, not raw provider/driver
messages. Ordinary provider failures do not invoke that callback: monitor
`queueStats()` and inspect `listEmbeddingFailures()` from your operational
monitoring process as well. See the
[embedding guide](../../docs/guides/embeddings.md#run-a-continuous-worker).
