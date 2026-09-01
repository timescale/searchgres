import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSearchgresClient } from "@searchgres/client";
import { Command, InvalidArgumentError } from "commander";
import { createMcpServer, MCP_VERSION } from "./server.ts";

export async function runProgram(argv: readonly string[]): Promise<void> {
  const program = new Command()
    .name("sg-mcp")
    .description("Searchgres MCP server over stdio")
    .showSuggestionAfterError()
    .version(MCP_VERSION)
    .option("--server <url>", "server URL; defaults to SEARCHGRES_URL")
    .option("--read-only", "omit all mutating tools")
    .option(
      "--timeout <duration>",
      "per-operation timeout",
      parseDuration,
      35_000,
    );

  await program.parseAsync(["node", "sg-mcp", ...argv]);
  const options = program.opts<{
    server?: string;
    readOnly?: boolean;
    timeout: number;
  }>();
  const serverUrl = options.server ?? process.env.SEARCHGRES_URL;
  if (!serverUrl) throw new Error("--server or SEARCHGRES_URL is required");

  const client = createSearchgresClient({
    url: `${serverUrl.replace(/\/$/, "")}/rpc`,
  });
  const mcp = createMcpServer({
    client,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    timeoutMs: options.timeout,
  });
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await mcp.close();
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  console.error("sg-mcp running on stdio");
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value);
  if (!match?.[1])
    throw new InvalidArgumentError(
      "expected a duration such as 500ms, 35s, or 2m",
    );
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  const result = amount * multiplier;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new InvalidArgumentError("timeout must be a positive safe duration");
  }
  return result;
}
