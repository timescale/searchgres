import { parentPort, workerData } from "node:worker_threads";
import { truncateText } from "./tokenizer.ts";
import type { TokenizerPoolOptions } from "./tokenizer-pool.ts";

interface Request {
  readonly id: number;
  readonly texts: readonly string[];
}

const port = parentPort;
if (!port) {
  throw new Error("tokenizer.worker must run inside a worker thread");
}

const options = workerData as Required<TokenizerPoolOptions>;

port.on("message", async (request: Request) => {
  try {
    const texts = await Promise.all(
      request.texts.map((text) => truncateText(options, text)),
    );
    port.postMessage({ id: request.id, texts });
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
