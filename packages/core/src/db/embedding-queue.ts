import type postgres from "postgres";
import type { VectorType } from "../config.ts";
import { runSql } from "../sql/exec.ts";

/**
 * Operational queue engine for asynchronous embedding generation.
 *
 * Unlike CRUD/search (schema-local PL/pgSQL routines), the drain path is
 * set-based dynamic SQL built here in TypeScript: it is not part of the
 * immutable schema format and is not needed by direct SQL writers (only the
 * triggers are). Every statement is fully schema-qualified.
 *
 * Concurrency model (at-least-once lease):
 *  - A claim locks eligible rows `for update skip locked`, so many drainers on
 *    many processes share one queue without blocking each other.
 *  - Claiming pushes `visible_at` into the future (the lease) and increments
 *    `attempts`, so a crashed drainer's rows become claimable again after the
 *    lease lapses rather than being lost.
 *  - The embedding provider is called OUTSIDE any transaction; write-back is a
 *    separate short transaction. The queue — not the SDK — is the retry
 *    authority.
 *  - Every write-back is guarded by the record's `content_version`, so a vector
 *    generated for a stale record state can never overwrite a newer one.
 */

/** A queue row claimed for embedding, paired with the record content to embed. */
export interface ClaimedRow {
  readonly queueId: string;
  readonly recordId: string;
  readonly contentVersion: number;
  readonly content: string;
}

export interface ClaimResult {
  readonly rows: readonly ClaimedRow[];
  /** Candidate rows cancelled during this claim because they were stale. */
  readonly cancelled: number;
}

export interface QueueStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly waiting: number;
  readonly failed: number;
  readonly oldestPendingAt: Date | null;
}

interface CandidateRow {
  readonly queue_id: string;
  readonly record_id: string;
  readonly content_version: number;
  readonly content: string | null;
  readonly claimed: boolean;
}

/**
 * Claim up to `batchSize` rows. Runs two statements:
 *  1. a sweep that finalizes rows which exhausted their attempt budget (a row
 *     stranded by a crash after its final claim would otherwise stay pending
 *     forever);
 *  2. the claim itself, which also cancels stale candidates in the same
 *     statement/snapshot.
 *
 * The claim's staleness check is the counterpart to record_integrity's
 * content_version fence: a candidate whose record was deleted (`content is
 * null` via the left join) or whose current `content_version` no longer matches
 * the queued one is cancelled, never claimed. This catches the case a newer
 * queue row cannot — a precomputed vector written with no content change bumps
 * content_version WITHOUT enqueuing a new row, leaving the old row's version
 * behind the record's.
 */
export async function claimBatch(
  sql: postgres.Sql,
  schema: string,
  options: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  },
): Promise<ClaimResult> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  const record = sql`${sql(schema)}.record`;

  await runSql(
    sql`
      update ${queue}
      set outcome = 'failed'
        , last_error = coalesce(last_error, 'exceeded max attempts')
        , updated_at = now()
      where outcome is null
        and visible_at <= now()
        and attempts >= ${options.maxAttempts}
    `,
    {
      spanName: "sweepExhaustedEmbeddings",
      dbOperationName: "UPDATE",
      namespace: schema,
    },
  );

  const candidates = await runSql(
    sql<CandidateRow[]>`
      with candidate as (
        -- Lock the oldest eligible rows and skip any a concurrent drainer holds.
        select q.id, q.record_id, q.content_version
        from ${queue} q
        where q.outcome is null
          and q.visible_at <= now()
          and q.attempts < ${options.maxAttempts}
        order by q.visible_at
        for update skip locked
        limit ${options.batchSize}
      ),
      joined as (
        -- Left join so a deleted record surfaces as content is null.
        select
          c.id
        , c.record_id
        , c.content_version
        , r.content as record_content
        , r.content_version as current_version
        from candidate c
        left join ${record} r on r.id = c.record_id
      ),
      cancelled as (
        -- Stale: record gone, or its content_version moved past the queued one.
        update ${queue} q
        set outcome = 'cancelled', updated_at = now()
        from joined j
        where q.id = j.id
          and (j.record_content is null
               or j.current_version is distinct from j.content_version)
        returning q.id
      ),
      claimed as (
        -- Fresh: extend the lease and spend one attempt.
        update ${queue} q
        set attempts = q.attempts + 1
          , visible_at = now() + (${options.leaseMs} * interval '1 millisecond')
          , updated_at = now()
        from joined j
        where q.id = j.id
          and j.record_content is not null
          and j.current_version is not distinct from j.content_version
        returning q.id
      )
      select
        j.id::text as queue_id
      , j.record_id
      , j.content_version
      , j.record_content as content
      , (cl.id is not null) as claimed
      from joined j
      left join claimed cl on cl.id = j.id
      order by j.id
    `,
    {
      spanName: "claimEmbeddingBatch",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );

  const rows: ClaimedRow[] = [];
  let cancelled = 0;
  for (const candidate of candidates) {
    if (candidate.claimed && candidate.content !== null) {
      rows.push({
        queueId: candidate.queue_id,
        recordId: candidate.record_id,
        contentVersion: candidate.content_version,
        content: candidate.content,
      });
    } else {
      cancelled++;
    }
  }
  return { rows, cancelled };
}

/**
 * Version-guarded write-back. Installs the vector only if the queue row is still
 * active AND the record still has the claimed content_version, then finalizes
 * the queue row atomically. Returns 'completed' when the vector was written,
 * 'cancelled' when the record moved on or the row was already terminal.
 *
 * The `active` CTE locks the queue row and yields it only while `outcome is
 * null`; the record write is joined off it, so a vector is never installed for a
 * row another actor already finalized. The record predicate `content_version =`
 * is the fence that rejects a stale vector. Only the queue row is updated (once),
 * avoiding "tuple already modified" from double-updating it in one statement.
 */
export async function completeEmbedding(
  sql: postgres.Sql,
  schema: string,
  vectorType: VectorType,
  input: {
    readonly queueId: string;
    readonly recordId: string;
    readonly contentVersion: number;
    readonly embedding: string;
  },
): Promise<"completed" | "cancelled"> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  const record = sql`${sql(schema)}.record`;
  const vector =
    vectorType === "halfvec"
      ? sql`${input.embedding}::public.halfvec`
      : sql`${input.embedding}::public.vector`;

  const [row] = await runSql(
    sql<{ outcome: "completed" | "cancelled" }[]>`
      with active as (
        select record_id, content_version
        from ${queue}
        where id = ${input.queueId} and outcome is null
        for update
      ),
      written as (
        update ${record} rec
        set embedding = ${vector}
        from active a
        where rec.id = a.record_id
          and rec.content_version = a.content_version
        returning rec.id
      ),
      finalized as (
        update ${queue}
        set outcome = case when exists (select 1 from written) then 'completed' else 'cancelled' end
          , updated_at = now()
        where id = ${input.queueId} and outcome is null
        returning outcome
      )
      select coalesce((select outcome from finalized), 'cancelled') as outcome
    `,
    {
      spanName: "completeEmbedding",
      dbOperationName: "UPDATE",
      namespace: schema,
    },
  );
  return row?.outcome ?? "cancelled";
}

/**
 * Record a transient failure without finalizing: leaves `outcome` null so the
 * row retries after its lease lapses. The claim sweep terminally fails it once
 * attempts are exhausted. No-op if the row was already finalized or cascade-
 * deleted with its record.
 */
export async function failEmbedding(
  sql: postgres.Sql,
  schema: string,
  input: { readonly queueId: string; readonly error: string },
): Promise<void> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  await runSql(
    sql`
      update ${queue}
      set last_error = ${input.error}, updated_at = now()
      where id = ${input.queueId} and outcome is null
    `,
    { spanName: "failEmbedding", dbOperationName: "UPDATE", namespace: schema },
  );
}

/**
 * Undo a claim after a rate limit: refund the attempt (a 429 must not spend the
 * budget) and defer visibility by `backoffMs`. Deferring rather than resetting
 * to now() stops another drainer from re-grabbing the row mid-backoff and
 * re-triggering the throttle.
 */
export async function releaseEmbedding(
  sql: postgres.Sql,
  schema: string,
  input: { readonly queueId: string; readonly backoffMs: number },
): Promise<void> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  await runSql(
    sql`
      update ${queue}
      set attempts = greatest(attempts - 1, 0)
        , visible_at = now() + (${input.backoffMs} * interval '1 millisecond')
        , updated_at = now()
      where id = ${input.queueId} and outcome is null
    `,
    {
      spanName: "releaseEmbedding",
      dbOperationName: "UPDATE",
      namespace: schema,
    },
  );
}

/** Delete terminal rows older than the retention window. Returns rows removed. */
export async function pruneQueue(
  sql: postgres.Sql,
  schema: string,
  retentionMs: number,
): Promise<number> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  const [row] = await runSql(
    sql<{ pruned: string }[]>`
      with deleted as (
        delete from ${queue}
        where outcome is not null
          and created_at < now() - (${retentionMs} * interval '1 millisecond')
        returning id
      )
      select count(*)::text as pruned from deleted
    `,
    {
      spanName: "pruneEmbeddingQueue",
      dbOperationName: "DELETE",
      namespace: schema,
    },
  );
  return Number(row?.pruned ?? 0);
}

/** Count of `outcome is null` rows after a bounded pass (used for `remaining`). */
export async function pendingCount(
  sql: postgres.Sql,
  schema: string,
): Promise<number> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  const [row] = await runSql(
    sql<{ pending: string }[]>`
      select count(*)::text as pending from ${queue} where outcome is null
    `,
    {
      spanName: "pendingEmbeddingCount",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return Number(row?.pending ?? 0);
}

/** Aggregate queue snapshot for operational visibility. */
export async function queueStats(
  sql: postgres.Sql,
  schema: string,
): Promise<QueueStats> {
  const queue = sql`${sql(schema)}.embedding_queue`;
  const [row] = await runSql(
    sql<
      {
        pending: string;
        in_flight: string;
        waiting: string;
        failed: string;
        oldest_pending_at: Date | null;
      }[]
    >`
      select
        count(*) filter (where outcome is null)::text as pending
      , count(*) filter (where outcome is null and visible_at > now())::text as in_flight
      , count(*) filter (where outcome is null and visible_at <= now())::text as waiting
      , count(*) filter (where outcome = 'failed')::text as failed
      , min(created_at) filter (where outcome is null) as oldest_pending_at
      from ${queue}
    `,
    {
      spanName: "embeddingQueueStats",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return {
    pending: Number(row?.pending ?? 0),
    inFlight: Number(row?.in_flight ?? 0),
    waiting: Number(row?.waiting ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingAt: row?.oldest_pending_at ?? null,
  };
}
