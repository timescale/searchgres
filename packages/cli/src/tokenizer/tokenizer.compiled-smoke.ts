import { TokenizerPool } from "./tokenizer-pool.ts";

const pool = new TokenizerPool({
  preset: "nomic-embed-text-v1.5",
  maxTokens: 2,
  threads: 1,
});
console.log(await pool.truncate("Hello world there"));
await pool.shutdown();
