# Searchgres MCP reference server

`searchgres-mcp` is a maintained reference implementation that adapts one
Searchgres API server into twelve MCP tools over stdio. It is an unprivileged
remote client: it never reads server config, dotenv, database or embedding
credentials, or arbitrary import/export files. You do not need it to use the
core library.

The MCP process does not authenticate or secure the HTTP server it calls. Keep
the API on loopback or behind a trusted security boundary as described in the
[API server warning](../guides/server.md#security-boundary). MCP `--read-only`
omits mutating tools from the agent, but is capability reduction rather than
authentication; backend read-only mode remains authoritative.

## Run

Pass the base server URL explicitly:

```sh
searchgres-mcp --server http://127.0.0.1:3000
```

or through the same environment variable as `searchgres`:

```sh
SEARCHGRES_URL=http://127.0.0.1:3000 searchgres-mcp
```

The process writes MCP frames only to stdout and operational messages to stderr.
Searchgres does not install or modify configuration for individual agent
harnesses; configure this standards-compliant stdio command in the MCP host.

Options:

```text
--server <url>       Override SEARCHGRES_URL
--read-only          Omit every mutating tool
--timeout <duration> Per-operation timeout (default 35s; accepts ms, s, or m)
--help
--version
```

All twelve tools are registered by default. Backend read-only mode remains
authoritative even when write tools are visible.

## Read tools

- [`searchgres_info`](./searchgres_info.md)
- [`searchgres_search`](./searchgres_search.md)
- [`searchgres_get`](./searchgres_get.md)
- [`searchgres_tree`](./searchgres_tree.md)
- [`searchgres_count`](./searchgres_count.md)

## Write tools

- [`searchgres_create`](./searchgres_create.md)
- [`searchgres_create_many`](./searchgres_create_many.md)
- [`searchgres_update`](./searchgres_update.md)
- [`searchgres_delete`](./searchgres_delete.md)
- [`searchgres_move_tree`](./searchgres_move_tree.md)
- [`searchgres_copy_tree`](./searchgres_copy_tree.md)
- [`searchgres_delete_tree`](./searchgres_delete_tree.md)

Tree mutations require an explicit `dryRun` Boolean. Passing false executes the
operation; it is not an interactive confirmation mechanism.

## Search and local selection

Search accepts the existing recursive structured protocol filter object. It does
not accept the CLI S-expression DSL. For example:

```json
{
  "semantic": "how indexing works",
  "filter": {
    "and": [
      { "tree": "docs" },
      { "meta": { "status": "published" } }
    ]
  },
  "select": ["id", "tree", "name", "score", "content:500"]
}
```

`select` is also available on `searchgres_get`. It is applied after the complete
record arrives from the API and never crosses the RPC boundary. Omitting it
returns the full record. Selectors support ordinary fields, exact top-level
`meta.KEY` names, and Unicode code-point content ranges such as `content:500`,
`content:10..100`, and `content:-100..`.

Tool results are emitted once as compact JSON text. V1 deliberately does not
duplicate results into MCP `structuredContent`.

See [agent instructions](./agent-instructions.md) for concise operating guidance.
