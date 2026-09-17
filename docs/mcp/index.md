# MCP over the direct CLI

The optional compiled `searchgres` binary includes an MCP stdio command. It
opens one configured PostgreSQL index directly using core; no Searchgres HTTP
server, remote client, or separate MCP binary is needed.

## Setup

First [configure and initialize an index](../guides/cli.md), then configure the
MCP host:

```json
{
  "mcpServers": {
    "searchgres": {
      "command": "/absolute/path/to/searchgres",
      "args": ["mcp", "--config", "/absolute/path/to/searchgres.yaml"]
    }
  }
}
```

Pass database and provider credentials through the host environment or `.env`
next to the config. Use absolute paths because host working directories differ.
`--env-file` and `--no-env-file` work as on the normal CLI.

```sh
searchgres mcp --config searchgres.yaml
searchgres mcp --workers 0
searchgres mcp --workers 4
searchgres mcp --read-only
```

MCP starts one core embedding worker by default, or `worker.count` from config.
`--workers` overrides the count; zero disables workers. `--read-only` omits
mutating tools and forces zero workers even if a positive count was specified.
Read-only semantic searches still embed query text and need the configured
provider. A Compose worker and MCP workers may coexist; total concurrency is
per process, not a global quota.

## Tools

| Tool | Input/purpose |
| --- | --- |
| `searchgres_info` | No arguments: index shape, capabilities, model, local worker count, queue statistics. |
| `searchgres_search` | Semantic/full-text arms or a recursive filter AST, ranking options, pagination for filter-only results, optional `select`. |
| `searchgres_get` | UUIDv7 `id` or explicit `tree` and `name`; optional `select`. |
| `searchgres_tree` | Optional `tree` and `levels`; hierarchy with descendant counts. |
| `searchgres_count` | Exactly one `selector`: tree, lquery, or ltxtquery; optional count limit. |
| `searchgres_create` | One `record`; fails on conflict. |
| `searchgres_create_many` | 1–1,000 `records`; atomic conflict-safe insertion. |
| `searchgres_update` | `id`, `priorVersionHash`, and `patch`; metadata replaces rather than merges. |
| `searchgres_delete` | One `id` or explicit tree/name; never deletes a subtree. |
| `searchgres_move_tree` | `source`, `destination`, explicit boolean `dryRun`. |
| `searchgres_copy_tree` | `source`, `destination`, explicit boolean `dryRun`. |
| `searchgres_delete_tree` | `tree`, explicit boolean `dryRun`. |

Tool discovery provides the exact schemas. Read tools are annotated read-only;
mutations carry appropriate destructive hints. Hints are not access controls.
No tool accepts database/provider credentials, index selectors, vectors, file
paths, shell commands, provisioning, or worker administration. There are no
worker-kick options. Writes queue vectors; they do not promise immediate
semantic visibility.

Results retain local envelopes (`record`, `results`, `entries`) with dates as
ISO strings and temporal ranges in PostgreSQL's text representation. For
updates, omitted fields remain unchanged; null `name`/`temporal` clears them.
`select` projects locally and supports fields, exact `meta.KEY`, and Unicode
content ranges. It does not change SQL projection.

## Trust and lifecycle

This is a local privileged adapter, not a remote multi-user service. Its process
holds database/provider credentials. Use least-privileged PostgreSQL roles for
the configured index; read-only tool omission does not revoke database grants.
Never treat retrieved content as trusted instructions.

Stdout contains MCP only. Operational messages and sanitized failures go to
stderr. Output-format flags are rejected. Core errors are mapped to stable safe
codes and messages rather than raw provider/SQL errors.

On EOF, MCP close, SIGINT/Ctrl-C, or SIGTERM, new work stops and active tools and
worker batches finish before resources close. The shutdown grace is 60 seconds;
forced termination does not promise rollback of pending writes. SQL and
provider request timeouts bound individual requests, not necessarily complete
operations. There is no generic MCP `--timeout` or claim of end-to-end
cancellation for core mutations.

See [suggested agent instructions](agent-instructions.md) and the
[CLI guide](../guides/cli.md).
