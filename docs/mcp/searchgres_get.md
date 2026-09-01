# `searchgres_get`

## Get one record

Gets a record by UUIDv7 `id`, or by explicit `tree` and `name`. `select` is local and optional; `score` is not valid for stored-record selection.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
