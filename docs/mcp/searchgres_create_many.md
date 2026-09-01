# `searchgres_create_many`

## Create records atomically

Safely inserts 1–1,000 records atomically. Any conflict fails the whole call; the tool does not chunk, retry, replace, or ignore.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
