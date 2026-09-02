import { JSON5, YAML } from "bun";

/**
 * Serialize a generated server config in the encoding its filename implies.
 * `searchgres-server config` writes the file; `init`, `serve`, and `destroy` read it
 * back through loadServerConfig.
 */
export function renderConfig(path: string, config: unknown): string {
  const name = path.toLowerCase();
  if (name.endsWith(".json5")) return `${JSON5.stringify(config, null, 2)}\n`;
  if (name.endsWith(".yaml") || name.endsWith(".yml"))
    return `${YAML.stringify(config)}\n`;
  throw new Error("Config path must end in .yaml, .yml, or .json5");
}
