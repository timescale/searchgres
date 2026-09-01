# `searchgres_search`

## Search records

Runs semantic, full-text, hybrid, or filter-only search with the recursive structured filter object. `select` projects complete RPC results locally using the same selectors as `sg search --select`.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
