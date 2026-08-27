/**
 * Truncation is caller-supplied runtime policy: searchgres cannot know an
 * arbitrary embedding provider's token limit, so it never truncates unless the
 * caller opts in at {@link openIndex}. A `Truncator` is applied to record content
 * (by the embedding worker) and to semantic query text (before embedding).
 */
export type Truncator = (text: string) => string | Promise<string>;

/** The default: return the text unchanged. */
export const noTruncation: Truncator = (text) => text;

/** Truncate to at most `maxChars` UTF-16 code units, splitting on a code point. */
export function truncateCharacters(maxChars: number): Truncator {
  assertPositiveInteger(maxChars, "maxChars");
  return (text) => {
    if (text.length <= maxChars) {
      return text;
    }
    // Avoid slicing through a surrogate pair.
    const end =
      isLowSurrogate(text.charCodeAt(maxChars)) &&
      isHighSurrogate(text.charCodeAt(maxChars - 1))
        ? maxChars - 1
        : maxChars;
    return text.slice(0, end);
  };
}

/** Truncate to at most `maxBytes` of UTF-8, never emitting a partial code point. */
export function truncateBytes(maxBytes: number): Truncator {
  assertPositiveInteger(maxBytes, "maxBytes");
  const encoder = new TextEncoder();
  // `fatal: false` drops a trailing partial sequence rather than throwing; we
  // also strip a replacement char it may leave at the boundary.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return (text) => {
    const bytes = encoder.encode(text);
    if (bytes.length <= maxBytes) {
      return text;
    }
    const decoded = decoder.decode(bytes.subarray(0, maxBytes));
    return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded;
  };
}

/** A caller-supplied tokenizer codec, e.g. from `gpt-tokenizer` or `js-tiktoken`. */
export interface TokenCodec {
  encode(text: string): ArrayLike<number>;
  decode(tokens: number[]): string;
}

/** Truncate to at most `maxTokens` using a caller-supplied codec. */
export function truncateTokens(options: {
  readonly encode: TokenCodec["encode"];
  readonly decode: TokenCodec["decode"];
  readonly maxTokens: number;
}): Truncator {
  assertPositiveInteger(options.maxTokens, "maxTokens");
  return (text) => {
    const tokens = options.encode(text);
    if (tokens.length <= options.maxTokens) {
      return text;
    }
    return options.decode(Array.from(tokens).slice(0, options.maxTokens));
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
