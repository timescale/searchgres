import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfiguredCommand } from "../config/config.ts";
import { type Flags, nonnegativeInteger, requiredFlag } from "../flags.ts";
import { installShutdown, openRuntime } from "../runtime/index.ts";
import { InputError, safeError } from "../runtime/report.ts";
import { createMcpServer } from "./server.ts";

export async function runMcp(flags: Flags): Promise<void> {
  if (["json", "yaml", "ndjson"].some((name) => flags.has(name)))
    throw new InputError(
      "MCP reserves stdout for its protocol; output format flags are not supported",
    );
  const { config } = await loadConfiguredCommand(flags);
  const runtime = await openRuntime(config);
  const mcp = createMcpServer({ runtime, readOnly: flags.has("read-only") });
  const transport = new StdioServerTransport();
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const shutdown = installShutdown(async () => {
    // runtime.close immediately prevents new tracked tools and worker claims;
    // leave transport available while accepted tool operations finish.
    await runtime.close();
    await mcp.close();
    process.stdin.off("end", eof);
    resolveDone();
  });
  const eof = () => {
    void shutdown.stop().catch((error) => {
      console.error(JSON.stringify({ error: safeError(error) }));
      process.exitCode = 1;
      resolveDone();
    });
  };
  try {
    const count = flags.has("read-only")
      ? 0
      : flags.has("workers")
        ? nonnegativeInteger(requiredFlag(flags, "workers"), "workers")
        : config.worker.count;
    if (count > 64) throw new InputError("--workers must be at most 64");
    runtime.startEmbeddingWorkers(count);
    mcp.server.onclose = eof;
    process.stdin.once("end", eof);
    await mcp.connect(transport);
    console.error(
      `Searchgres MCP running on stdio (${count} embedding workers)`,
    );
    await done;
  } finally {
    await shutdown.stop();
  }
}
