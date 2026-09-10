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

## Tools

The MCP host receives each tool's strict input schema during discovery. These
short descriptions document intent and important safety behavior without
maintaining a second copy of those generated schemas.

### Read tools

| Tool | Purpose |
| --- | --- |
| `searchgres_info` | Report API/server versions, capabilities, request-size limit, and backend read-only status. |
| `searchgres_search` | Run semantic, full-text, hybrid, or filter-only search. Supports the structured recursive filter and local `select` projection. |
| `searchgres_get` | Get one record by UUIDv7 `id` or by explicit `tree` and `name`, with optional local `select` projection. |
| `searchgres_tree` | View hierarchy nodes and descendant counts below an optional raw dotted tree path and level bound. |
| `searchgres_count` | Count records using exactly one `tree`, `lquery`, or `ltxtquery` selector; a capped result means at least the returned count. |

### Write tools

| Tool | Purpose |
| --- | --- |
| `searchgres_create` | Insert one record, failing rather than replacing on conflict. The server generates missing embeddings. |
| `searchgres_create_many` | Atomically insert 1–1,000 records; any conflict fails the whole call without chunking or retry. |
| `searchgres_update` | Optimistically patch one record using its latest `priorVersionHash`; metadata is replaced, not merged. |
| `searchgres_delete` | Permanently delete exactly one record by `id` or by explicit `tree` and `name`; never deletes a subtree. |
| `searchgres_move_tree` | Move an inclusive subtree while preserving relative structure. |
| `searchgres_copy_tree` | Copy an inclusive subtree with fresh record IDs while preserving relative structure. |
| `searchgres_delete_tree` | Permanently delete an inclusive subtree. |

Tree mutations require an explicit `dryRun` Boolean. Passing `false` executes
the operation; it is not an interactive confirmation mechanism. Record delete
and update are also destructive operations and do not prompt interactively.

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
