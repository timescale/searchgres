import { JSON5, YAML } from "bun";

/**
 * Serialize a generated CLI config in the encoding its filename implies.
 * `searchgres config` writes it; operational commands load the same file.
 */
export function renderConfig(path: string, config: unknown): string {
  const name = path.toLowerCase();
  if (name.endsWith(".json5")) return `${JSON5.stringify(config, null, 2)}\n`;
  if (name.endsWith(".yaml") || name.endsWith(".yml"))
    return `${YAML.stringify(config)}\n`;
  throw new Error("Config path must end in .yaml, .yml, or .json5");
}
