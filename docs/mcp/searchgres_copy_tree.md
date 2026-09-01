# `searchgres_copy_tree`

## Copy an inclusive subtree

Copies a raw dotted tree path and all descendants with fresh record IDs. `dryRun` is required; false executes the mutation.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
