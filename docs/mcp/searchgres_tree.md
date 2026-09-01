# `searchgres_tree`

## View the tree

Returns tree nodes and descendant counts under an optional raw dotted tree path and optional level bound.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
