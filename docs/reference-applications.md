# Reference implementations and evaluation tools

The **`searchgres` core library is the primary product**. Applications can use
it directly with their own PostgreSQL pool, embedding model, API boundary,
authentication, and operational policies.

This repository also contains maintained reference implementations. They show
one way to compose those application concerns around core, and provide a local
evaluation path. You do not need any of them to use the library, and their
interfaces do not constrain applications built directly on core.

## What each component demonstrates

| Component | What it demonstrates |
| --- | --- |
| `searchgres-server` | A Bun process that owns one pool, embedding model, index handle, background worker, and HTTP JSON-RPC boundary. |
| [`packages/client`](../packages/client/src/index.ts) | A runtime-neutral typed transport for the reference server's JSON-RPC protocol. |
| `searchgres` CLI | Remote ingestion, search, tree operations, and import/export through the reference client. |
| `searchgres-mcp` | Adapting the reference client to MCP tools for agents. |
| Docker Compose | A no-provider-key local evaluation stack with PostgreSQL, Ollama, provisioning, and the server. |

The protocol and client workspaces are currently private implementation
packages used by the reference binaries; they are not separately published npm
products. Their source can still be useful when designing a different transport
or application boundary.

## Choose a starting point

- To build an application, start with the **[core library walkthrough](getting-started.md)**
  and [architecture boundaries](concepts/architecture.md).
- To evaluate the complete search flow locally, use the
  **[Docker Compose stack](guides/docker-compose.md)**.
- To study or run the HTTP reference implementation, see the
  **[API server guide](guides/server.md)**. Its generated OpenRPC document is the
  authoritative description of its wire methods.
- To connect an agent to that server, see the **[MCP server](mcp/index.md)**.
- For CLI discovery, run `searchgres --help` and
  `searchgres <command> --help`; the Compose guide includes a short working
  sequence. Its optional S-expression filters follow the generated
  [filter syntax reference](reference/filter-syntax.html).

## Security and production use

The reference server deliberately contains no built-in authentication,
authorization, TLS termination, or rate limiting. The CLI, client, and MCP
server do not add those controls. Keep the server on loopback for local use, or
put it behind an application or trusted proxy that provides the required
security boundary.

See the API server's **[security warning](guides/server.md#security-boundary)**
before exposing any reference component over a network. The Compose stack is an
evaluation environment, not a production deployment.
