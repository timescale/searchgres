import { loadServerConfig } from "./config.ts";
import { startServer } from "./server.ts";

const [command, configFlag, configPath] = process.argv.slice(2);
if (command !== "server" || configFlag !== "--config" || !configPath) {
  throw new Error("Usage: sg server --config <config.yaml|config.json5>");
}

const config = await loadServerConfig(configPath);
const server = await startServer(config);
console.log(`searchgres server listening on ${server.url}`);

const stop = async () => {
  await server.stop();
  process.exitCode = 0;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
