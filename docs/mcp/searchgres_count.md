# `searchgres_count`

## Count records

Counts records selected by exactly one explicit `tree`, `lquery`, or `ltxtquery` selector. When `capped` is true, interpret the result as at least the returned count.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
