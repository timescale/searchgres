# `searchgres_delete_tree`

## Delete an inclusive subtree

Permanently deletes a raw dotted tree path and all descendants. `dryRun` is required; false executes irreversible deletion.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
