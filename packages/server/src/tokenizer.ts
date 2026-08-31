import { Tokenizer } from "@huggingface/tokenizers";
import { decode, encode } from "gpt-tokenizer/encoding/cl100k_base";
import nomicModernBertTokenizer from "../assets/nomic-ai/modernbert-embed-base/tokenizer.json" with {
  type: "json",
};
import nomicModernBertConfig from "../assets/nomic-ai/modernbert-embed-base/tokenizer_config.json" with {
  type: "json",
};
import nomicTextTokenizer from "../assets/nomic-ai/nomic-embed-text-v1.5/tokenizer.json" with {
  type: "json",
};
import nomicTextConfig from "../assets/nomic-ai/nomic-embed-text-v1.5/tokenizer_config.json" with {
  type: "json",
};
import type {
  TokenizerPoolOptions,
  TokenizerPreset,
} from "./tokenizer-pool.ts";

const WINDOW_CHARS = 1_000;

const nomicAssets = {
  "nomic-embed-text-v1.5": {
    tokenizer: nomicTextTokenizer,
    config: nomicTextConfig,
  },
  "nomic-modernbert-embed-base": {
    tokenizer: nomicModernBertTokenizer,
    config: nomicModernBertConfig,
  },
} as const satisfies Partial<Record<TokenizerPreset, object>>;

type NomicPreset = keyof typeof nomicAssets;

interface NomicTokenizer {
  encode(
    text: string,
    options: { add_special_tokens: false },
  ): { readonly ids: number[] };
  decode(tokens: number[]): string;
}

const nomicTokenizers = new Map<NomicPreset, Promise<NomicTokenizer>>();

export async function truncateText(
  options: Pick<TokenizerPoolOptions, "preset" | "maxTokens">,
  text: string,
): Promise<string> {
  return options.preset === "openai-cl100k-base"
    ? truncateCl100k(text, options.maxTokens)
    : truncateNomic(options.preset, text, options.maxTokens);
}

function truncateCl100k(text: string, maxTokens: number): string {
  if (text.length <= Math.floor(maxTokens / 3)) {
    return text;
  }
  const tokens: number[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + WINDOW_CHARS, text.length);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      end += 1;
    }
    tokens.push(...encode(text.slice(start, end)));
    if (
      tokens.length > maxTokens ||
      (tokens.length === maxTokens && end < text.length)
    ) {
      return decode(tokens.slice(0, maxTokens));
    }
    start = end;
  }
  return text;
}

async function truncateNomic(
  preset: Exclude<TokenizerPreset, "openai-cl100k-base">,
  text: string,
  maxTokens: number,
): Promise<string> {
  const tokenizer = await getNomicTokenizer(preset);
  // A fixed multiple bounds pathological CJK/whitespace-free input while
  // retaining enough ordinary-prose prefix to fill a budget. The final token-ID
  // cut remains exact even when this conservative CPU window overflows it.
  const limit = maxTokens * 12;
  let end = Math.min(text.length, limit);
  if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }
  const source = text.slice(0, end);
  const tokens = tokenizer.encode(source, { add_special_tokens: false }).ids;
  if (end === text.length && tokens.length <= maxTokens) {
    return text;
  }
  return tokenizer.decode(tokens.slice(0, maxTokens));
}

function getNomicTokenizer(
  preset: Exclude<TokenizerPreset, "openai-cl100k-base">,
): Promise<NomicTokenizer> {
  let tokenizer = nomicTokenizers.get(preset);
  if (!tokenizer) {
    // These model-pinned assets ship with the server package. Loading never
    // contacts the Hugging Face Hub at startup or on the request path.
    tokenizer = loadNomicTokenizer(nomicAssets[preset]);
    nomicTokenizers.set(preset, tokenizer);
  }
  return tokenizer;
}

async function loadNomicTokenizer(assets: {
  readonly tokenizer: object;
  readonly config: object;
}): Promise<NomicTokenizer> {
  return new Tokenizer(assets.tokenizer, assets.config) as NomicTokenizer;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
