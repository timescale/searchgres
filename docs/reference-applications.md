# Reference CLI and MCP

The published **`searchgres` core library is the primary product**. The repository
also maintains one compiled `searchgres` executable for evaluation and as a
reference for applications built directly on core. It is optional and does not
constrain applications using the library.

There is no Searchgres HTTP service, remote client, or separately published
protocol. The binary opens one configured PostgreSQL index and owns its pool,
OpenAI-compatible model, tokenizer resources, and workers. `searchgres mcp`
exposes twelve tools over stdio using that same runtime.

## Start here

- [CLI configuration and commands](guides/cli.md)
- [Docker Compose evaluation](guides/docker-compose.md)
- [MCP setup and tools](mcp/index.md)
- [Core examples](../examples/README.md)

## Boundaries

Only `packages/core` is published to npm. `packages/cli` contains private source
for the compiled binary, including filter parsing, presentation, MCP, exact
tokenizer assets, and configuration. The library remains runtime-neutral; the
binary is compiled with Bun and needs no JavaScript runtime installed.

CLI/MCP receive database and optional provider credentials directly. Keep them
local and trusted, use PostgreSQL grants appropriate to the configured index,
and do not pass secrets as tool inputs. MCP is not an HTTP service or a
multi-user authorization boundary. Read-only MCP omits mutation tools and
workers; semantic query embedding still contacts the configured provider.

Every reader and generator for an index must use the same model and truncation
policy. The user is responsible for configuring compatible endpoints and models.

## Breaking replacement

The former server/client/protocol stack and separate server/MCP executables are
removed. Old configuration files and `--server` invocations are not supported.
Generate a new config with `searchgres config` and configure MCP hosts to run
`searchgres mcp`. Existing core index formats and library APIs are unchanged.
