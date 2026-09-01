# `searchgres_update`

## Update one record

Optimistically patches a record using its latest `priorVersionHash`. Metadata is replaced rather than merged, and content changes queue re-embedding.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
