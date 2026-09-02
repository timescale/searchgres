import type { Index } from "searchgres";
import type { ServerConfig } from "./config.ts";

type ConfiguredIndex = ServerConfig["index"];
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
  throw new Error(
    `Index ${JSON.stringify(configured.schema)} does not match the server config: ` +
      `configured ${configured.vectorType}(${configured.dimensions}), ` +
      `database has ${index.vectorType}(${index.dimensions})`,
  );
}
