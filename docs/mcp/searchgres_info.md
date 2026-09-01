# `searchgres_info`

## Server information

Returns API version, server version, request-size limit, capabilities, and backend read-only status.

The tool talks only to the configured Searchgres API server. Results are compact
JSON text. Inputs are strictly validated before the HTTP request. Optional model-generated
`null` values are normalized where null does not represent an explicit record update.
