import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import workerSource from "./tokenizer.worker.generated.cjs" with {
  type: "text",
};

export const tokenizerPresets = [
  "openai-cl100k-base",
  "nomic-embed-text-v1.5",
  "nomic-modernbert-embed-base",
] as const;

export type TokenizerPreset = (typeof tokenizerPresets)[number];

interface Request {
  readonly id: number;
  readonly texts: readonly string[];
}

interface Response {
  readonly id: number;
  readonly texts?: string[];
  readonly error?: string;
}

interface Job extends Request {
  readonly resolve: (texts: string[]) => void;
  readonly reject: (error: Error) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  current: Job | undefined;
}

export interface TokenizerPoolOptions {
  readonly preset: TokenizerPreset;
  readonly maxTokens: number;
  /** `undefined` selects a conservative automatic size; zero runs inline. */
  readonly threads?: number;
}

/**
 * Bounded server-owned exact-tokenization pool. Each server has exactly one
 * preset, so jobs need no model routing and a single batched message preserves
 * embedding-batch alignment.
 */
export class TokenizerPool {
  readonly #options: Required<TokenizerPoolOptions>;
  readonly #workers: WorkerSlot[] = [];
  readonly #queue: Job[] = [];
  #nextId = 1;
  #closed = false;

  constructor(options: TokenizerPoolOptions) {
    this.#options = {
      ...options,
      threads: options.threads ?? defaultThreadCount(),
    };
    for (let i = 0; i < this.#options.threads; i += 1) {
      this.#workers.push(this.#createWorker());
    }
  }

  async truncate(text: string): Promise<string> {
    const [result] = await this.truncateMany([text]);
    if (result === undefined) {
      throw new Error("Tokenizer pool returned no result for one text");
    }
    return result;
  }

  truncateMany(texts: readonly string[]): Promise<string[]> {
    if (this.#closed) {
      return Promise.reject(new Error("Tokenizer pool is shut down"));
    }
    if (texts.length === 0) {
      return Promise.resolve([]);
    }
    if (this.#workers.length === 0) {
      return truncateInline(this.#options, texts);
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({ id: this.#nextId++, texts, resolve, reject });
      this.#dispatch();
    });
  }

  async shutdown(): Promise<void> {
    this.#closed = true;
    while (this.#queue.length > 0) {
      this.#queue.shift()?.reject(new Error("Tokenizer pool shut down"));
    }
    const workers = this.#workers.splice(0);
    await Promise.allSettled(
      workers.map(async (slot) => {
        slot.current?.reject(new Error("Tokenizer pool shut down"));
        await slot.worker.terminate();
      }),
    );
  }

  #createWorker(): WorkerSlot {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: this.#options,
    });
    worker.unref();
    const slot: WorkerSlot = { worker, current: undefined };
    worker.on("message", (message: Response) => {
      const job = slot.current;
      if (!job || job.id !== message.id) {
        return;
      }
      slot.current = undefined;
      if (message.error) {
        job.reject(new Error(message.error));
      } else if (!message.texts || message.texts.length !== job.texts.length) {
        job.reject(new Error("Tokenizer worker returned misaligned results"));
      } else {
        job.resolve(message.texts);
      }
      this.#dispatch();
    });
    worker.on("error", (error) => this.#replaceWorker(slot, error));
    worker.on("exit", (code) => {
      if (!this.#closed && code !== 0) {
        this.#replaceWorker(
          slot,
          new Error(`Tokenizer worker exited with code ${code}`),
        );
      }
    });
    return slot;
  }

  #replaceWorker(slot: WorkerSlot, error: Error): void {
    const index = this.#workers.indexOf(slot);
    if (index === -1) {
      return;
    }
    slot.current?.reject(error);
    slot.current = undefined;
    void slot.worker.terminate().catch(() => {});
    if (this.#closed) {
      this.#workers.splice(index, 1);
    } else {
      this.#workers[index] = this.#createWorker();
    }
    this.#dispatch();
  }

  #dispatch(): void {
    if (this.#closed) {
      return;
    }
    for (const slot of this.#workers) {
      if (slot.current || this.#queue.length === 0) {
        continue;
      }
      const job = this.#queue.shift();
      if (!job) {
        return;
      }
      slot.current = job;
      try {
        slot.worker.postMessage({ id: job.id, texts: job.texts });
      } catch (error) {
        this.#replaceWorker(
          slot,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}

export function defaultThreadCount(): number {
  return Math.max(1, Math.min(availableParallelism() - 1, 4));
}

async function truncateInline(
  options: Required<TokenizerPoolOptions>,
  texts: readonly string[],
): Promise<string[]> {
  const { truncateText } = await import("./tokenizer.ts");
  return Promise.all(texts.map((text) => truncateText(options, text)));
}
