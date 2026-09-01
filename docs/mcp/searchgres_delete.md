# `searchgres_delete`

## Delete one record

Permanently deletes exactly one record by `id`, or by explicit `tree` and `name`. It never interprets the address as a subtree.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
