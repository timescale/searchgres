import { trace } from "@opentelemetry/api";
import {
  claimBatch,
  completeEmbedding,
  failEmbedding,
  pendingCount,
  pruneQueue,
  releaseEmbedding,
} from "./db/embedding-queue.ts";
import { boundedError, embedTexts, resolveBatchSize } from "./embedding.ts";
import { DimensionMismatchError, RateLimitError } from "./errors.ts";
import type { Index } from "./open-index.ts";
import { LIBRARY_VERSION } from "./version.ts";

const tracer = trace.getTracer("searchgres", LIBRARY_VERSION);

const DEFAULT_LEASE_MS = 300_000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const MAX_ERROR_BACKOFF_MS = 60_000;

/** Options shared by the bounded pass and the continuous worker. */
interface DrainTuning {
  /** Rows to claim/embed per batch. Clamped to the model's max-per-call. */
  readonly batchSize?: number;
  /** Claim lease before a crashed drainer's rows become reclaimable. */
  readonly leaseDurationMs?: number;
  /** Attempts before a row is terminally failed. */
  readonly maxAttempts?: number;
}

export interface ProcessEmbeddingsOptions extends DrainTuning {
  /** Stop after this many batches (default: drain until no claimable work). */
  readonly maxBatches?: number;
  /** Stop once this wall-clock budget is exceeded (checked between batches). */
  readonly maxDurationMs?: number;
  /** Cooperative cancellation, checked before each claim. */
  readonly signal?: AbortSignal;
}

export interface ProcessEmbeddingsResult {
  /** Rows claimed for embedding across the pass. */
  readonly claimed: number;
  /** Vectors written back and finalized `completed`. */
  readonly embedded: number;
  /** Rows whose provider/write-back failed this pass (still pending to retry). */
  readonly failed: number;
  /** Rows cancelled as stale (at claim, or superseded before write-back). */
  readonly cancelled: number;
  /** `outcome is null` rows remaining after the pass. */
  readonly remaining: number;
}

export interface EmbeddingWorkerOptions extends DrainTuning {
  /** Idle delay between polls when no work was found (default 1s). */
  readonly intervalMs?: number;
  /** Retention for terminal rows the idle worker opportunistically prunes. */
  readonly pruneRetentionMs?: number;
}

export interface EmbeddingWorker {
  /** Stop polling and resolve once the in-flight batch (if any) finishes. */
  stop(): Promise<void>;
}

interface BatchOutcome {
  readonly claimed: number;
  readonly embedded: number;
  readonly failed: number;
  readonly cancelled: number;
}

/**
 * Run a bounded drain pass: claim → embed (outside any transaction) →
 * version-guarded write-back, repeated until a batch claims nothing or a bound
 * is hit. A provider rate limit or a wrong-dimension model output aborts the
 * pass by throwing (after releasing/refunding the claimed rows); ordinary
 * provider failures are recorded and reflected in `failed` while the pass
 * continues.
 */
export async function processEmbeddings(
  index: Index,
  options: ProcessEmbeddingsOptions = {},
): Promise<ProcessEmbeddingsResult> {
  const leaseMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const batchSize = await resolveBatchSize(index, options.batchSize);
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  const deadline =
    options.maxDurationMs === undefined
      ? Number.POSITIVE_INFINITY
      : Date.now() + options.maxDurationMs;

  return tracer.startActiveSpan("embedding.process", async (span) => {
    let claimed = 0;
    let embedded = 0;
    let failed = 0;
    let cancelled = 0;
    try {
      for (let batch = 0; batch < maxBatches; batch++) {
        if (options.signal?.aborted || Date.now() >= deadline) {
          break;
        }
        const outcome = await runBatch(index, {
          batchSize,
          leaseMs,
          maxAttempts,
        });
        claimed += outcome.claimed;
        embedded += outcome.embedded;
        failed += outcome.failed;
        cancelled += outcome.cancelled;
        // A batch that claimed nothing means the queue is drained for now.
        if (outcome.claimed === 0 && outcome.cancelled === 0) {
          break;
        }
      }
      const remaining = await pendingCount(index.sql, index.schema);
      span.setAttributes({
        "searchgres.embedding.claimed": claimed,
        "searchgres.embedding.embedded": embedded,
        "searchgres.embedding.failed": failed,
        "searchgres.embedding.cancelled": cancelled,
        "searchgres.embedding.remaining": remaining,
      });
      return { claimed, embedded, failed, cancelled, remaining };
    } finally {
      span.end();
    }
  });
}

async function runBatch(
  index: Index,
  tuning: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  },
): Promise<BatchOutcome> {
  const { rows, cancelled: cancelledAtClaim } = await claimBatch(
    index.sql,
    index.schema,
    tuning,
  );
  if (rows.length === 0) {
    return { claimed: 0, embedded: 0, failed: 0, cancelled: cancelledAtClaim };
  }

  let embeddings: readonly (readonly number[])[];
  try {
    embeddings = await embedTexts(
      index,
      rows.map((row) => row.content),
    );
  } catch (error) {
    // Rate limit and wrong-dimension are batch-level faults, not per-row
    // failures: refund the attempts and free the rows for a later retry (or a
    // correctly configured handle), then propagate so the caller can react.
    if (error instanceof RateLimitError) {
      const backoffMs = rateLimitBackoffMs(error.retryAfterMs);
      for (const row of rows) {
        await releaseEmbedding(index.sql, index.schema, {
          queueId: row.queueId,
          backoffMs,
        });
      }
      throw error;
    }
    if (error instanceof DimensionMismatchError) {
      for (const row of rows) {
        await releaseEmbedding(index.sql, index.schema, {
          queueId: row.queueId,
          backoffMs: 0,
        });
      }
      throw error;
    }
    // Ordinary provider failure: record it, leave rows pending; the queue is the
    // retry authority (they reappear after the lease and are terminally failed
    // once attempts are exhausted).
    const message = boundedError(error);
    for (const row of rows) {
      await failEmbedding(index.sql, index.schema, {
        queueId: row.queueId,
        error: message,
      });
    }
    return {
      claimed: rows.length,
      embedded: 0,
      failed: rows.length,
      cancelled: cancelledAtClaim,
    };
  }

  let embedded = 0;
  let failed = 0;
  let cancelled = cancelledAtClaim;
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position];
    const embedding = embeddings[position];
    if (!row || !embedding) {
      continue;
    }
    try {
      const outcome = await completeEmbedding(
        index.sql,
        index.schema,
        index.vectorType,
        {
          queueId: row.queueId,
          recordId: row.recordId,
          contentVersion: row.contentVersion,
          embedding: JSON.stringify(embedding),
        },
      );
      if (outcome === "completed") {
        embedded++;
      } else {
        cancelled++;
      }
    } catch (error) {
      failed++;
      await failEmbedding(index.sql, index.schema, {
        queueId: row.queueId,
        error: boundedError(error),
      });
    }
  }
  return { claimed: rows.length, embedded, failed, cancelled };
}

/**
 * Start a continuous single-index drainer. Processes one batch per tick,
 * continuing immediately while work exists and sleeping `intervalMs` when idle;
 * an idle tick opportunistically prunes terminal rows. `stop()` interrupts the
 * idle sleep and prevents another claim, but lets an in-flight batch finish, and
 * never closes the caller-owned pool.
 */
export function startEmbeddingWorker(
  index: Index,
  options: EmbeddingWorkerOptions = {},
): EmbeddingWorker {
  const intervalMs = options.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
  const pruneRetentionMs =
    options.pruneRetentionMs ?? DEFAULT_PRUNE_RETENTION_MS;
  const controller = new AbortController();
  const { signal } = controller;

  const loop = (async () => {
    let consecutiveErrors = 0;
    while (!signal.aborted) {
      try {
        // One batch per iteration; `signal` lets stop() land between batches.
        const result = await processEmbeddings(index, {
          maxBatches: 1,
          signal,
          ...(options.batchSize !== undefined
            ? { batchSize: options.batchSize }
            : {}),
          ...(options.leaseDurationMs !== undefined
            ? { leaseDurationMs: options.leaseDurationMs }
            : {}),
          ...(options.maxAttempts !== undefined
            ? { maxAttempts: options.maxAttempts }
            : {}),
        });
        consecutiveErrors = 0;
        if (result.claimed > 0 || result.cancelled > 0) {
          continue; // keep draining while there is work
        }
        // Idle: prune terminal rows opportunistically, then wait.
        try {
          await pruneQueue(index.sql, index.schema, pruneRetentionMs);
        } catch {
          // Best-effort; pruning never blocks the drain path.
        }
        await sleep(intervalMs, signal);
      } catch (error) {
        if (error instanceof RateLimitError) {
          await sleep(rateLimitBackoffMs(error.retryAfterMs), signal);
          continue;
        }
        // Bounded exponential backoff on repeated errors so a persistent
        // failure (e.g. a misconfigured model) doesn't hot-loop.
        consecutiveErrors++;
        const backoffMs = Math.min(
          intervalMs * 2 ** (consecutiveErrors - 1),
          MAX_ERROR_BACKOFF_MS,
        );
        await sleep(backoffMs, signal);
      }
    }
  })();

  return {
    async stop() {
      controller.abort();
      await loop;
    },
  };
}

function rateLimitBackoffMs(retryAfterMs: number | undefined): number {
  return retryAfterMs !== undefined && retryAfterMs > 0
    ? retryAfterMs
    : DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
