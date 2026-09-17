import { type Index, InvalidConfigError } from "searchgres";
import type { RuntimeConfig } from "./config.ts";

type ConfiguredIndex = RuntimeConfig["index"];
type OpenedIndexShape = Pick<Index, "schema" | "dimensions" | "vectorType">;

/** Refuse to serve or accept an existing index with a shape unlike the config. */
export function assertConfiguredIndexShape(
  index: OpenedIndexShape,
  configured: ConfiguredIndex,
): void {
  if (
    index.schema === configured.schema &&
    index.dimensions === configured.dimensions &&
    index.vectorType === configured.vectorType
  ) {
    return;
  }
  throw new InvalidConfigError(
    `Index ${JSON.stringify(configured.schema)} does not match the config: ` +
      `configured ${configured.vectorType}(${configured.dimensions}), ` +
      `database has ${index.vectorType}(${index.dimensions})`,
  );
}
