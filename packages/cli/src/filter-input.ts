import {
  type FilterExpressionError,
  MAX_FILTER_SOURCE_BYTES,
  parseFilter,
} from "@searchgres/filter";
import type { Filter } from "@searchgres/protocol";
import type { Flags } from "./flags.ts";
import { optionalFlag } from "./flags.ts";

const utf8BomBytes = 3;

/** Resolve and parse the mutually exclusive CLI filter-expression inputs. */
export async function filterExpressionFromFlags(
  flags: Flags,
): Promise<Filter | undefined> {
  const inline = optionalFlag(flags, "filter");
  const file = optionalFlag(flags, "filter-file");
  if (inline !== undefined && file !== undefined) {
    throw new Error("--filter cannot be combined with --filter-file");
  }
  if (inline !== undefined) return parseForCli(inline, "--filter");
  if (file === undefined) return undefined;

  const source = await readBoundedFilterSource(file);
  return parseForCli(source, file === "-" ? "stdin" : file);
}

export async function readBoundedFilterSource(path: string): Promise<string> {
  const stream = path === "-" ? Bun.stdin.stream() : Bun.file(path).stream();
  const bytes = await readBoundedBytes(
    stream,
    MAX_FILTER_SOURCE_BYTES + utf8BomBytes,
  );
  let source: string;
  try {
    source = new TextDecoder("utf-8", {
      fatal: true,
      // Preserve the marker so we can enforce and strip exactly one BOM.
      ignoreBOM: true,
    }).decode(bytes);
  } catch (cause) {
    throw new Error(
      `${path === "-" ? "stdin" : path}: filter source is not valid UTF-8`,
      {
        cause,
      },
    );
  }
  if (source.startsWith("\uFEFF")) {
    source = source.slice(1);
    if (source.startsWith("\uFEFF")) {
      throw new Error(
        `${path === "-" ? "stdin" : path}: filter source contains more than one UTF-8 BOM`,
      );
    }
  }
  // parseFilter performs the authoritative UTF-8 byte check after BOM removal.
  return source;
}

function parseForCli(source: string, sourceName: string): Filter {
  try {
    return parseFilter(source, { sourceName });
  } catch (error) {
    if (isFilterExpressionError(error)) {
      throw new Error(`Invalid filter expression: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function isFilterExpressionError(
  error: unknown,
): error is FilterExpressionError {
  return (
    error instanceof Error &&
    error.name === "FilterExpressionError" &&
    "reason" in error
  );
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        throw new Error(
          `filter source exceeds ${MAX_FILTER_SOURCE_BYTES} UTF-8 bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
