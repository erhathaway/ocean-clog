import { and, eq, or, sql, lte, isNull } from "drizzle-orm";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";
import { oceanSessions, runs } from "../db/schema.js";

export type RunRow = {
  run_id: string;
  session_id: string;
  clog_id: string;
  status: string;
  state: unknown;
  locked_by: string | null;
  lock_expires_at: number | null;
  attempt: number;
  max_attempts: number;
  wake_at: number | null;
  pending_input: unknown;
  last_error: string | null;
  created_ts: number;
  updated_ts: number;
};

export async function createSessionIfMissing(db: SqlClient, sessionId: string): Promise<void> {
  await db
    .insert(oceanSessions)
    .values({ session_id: sessionId, created_ts: nowMs() })
    .onConflictDoNothing();
}

export async function createRun(
  db: SqlClient,
  opts: {
    runId: string;
    sessionId: string;
    clogId: string;
    initialState?: unknown;
    input?: unknown;
    maxAttempts?: number;
  },
): Promise<void> {
  await createSessionIfMissing(db, opts.sessionId);
  const hasInput = opts.input !== undefined;
  await db.insert(runs).values({
    run_id: opts.runId,
    created_ts: nowMs(),
    updated_ts: nowMs(),
    session_id: opts.sessionId,
    clog_id: opts.clogId,
    status: hasInput ? "pending" : "idle",
    state: opts.initialState ?? { created: nowMs() },
    pending_input: hasInput ? opts.input : null,
    max_attempts: opts.maxAttempts ?? 3,
  });
}

export async function getRun(db: SqlClient, runId: string): Promise<RunRow | null> {
  const rows = await db.select().from(runs).where(eq(runs.run_id, runId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    clog_id: row.clog_id,
    status: row.status,
    state: row.state,
    locked_by: row.locked_by,
    lock_expires_at: row.lock_expires_at,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    wake_at: row.wake_at,
    pending_input: row.pending_input,
    last_error: row.last_error,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  };
}

export async function signalRun(db: SqlClient, runId: string, input?: unknown): Promise<void> {
  const now = nowMs();
  // Set pending_input and flip status to "pending" if currently idle or waiting
  await db
    .update(runs)
    .set({
      pending_input: input ?? null,
      status: sql`CASE WHEN ${runs.status} IN ('idle', 'waiting') THEN 'pending' ELSE ${runs.status} END`,
      updated_ts: now,
    })
    .where(eq(runs.run_id, runId));
}

export async function acquireRun(
  db: SqlClient,
  instanceId: string,
  lockMs: number,
): Promise<RunRow | null> {
  const now = nowMs();
  const lockExpires = now + lockMs;

  // Atomic single-row lock acquisition. The outer WHERE duplicates the subquery
  // conditions intentionally: the subquery SELECT ... LIMIT 1 picks one eligible
  // run_id, and the outer WHERE re-checks the same predicates so the UPDATE is
  // a single atomic statement (no TOCTOU race between SELECT and UPDATE).
  const result = await db
    .update(runs)
    .set({
      locked_by: instanceId,
      lock_expires_at: lockExpires,
      updated_ts: now,
    })
    .where(
      and(
        or(eq(runs.status, "pending"), and(eq(runs.status, "waiting"), lte(runs.wake_at, now))),
        or(isNull(runs.locked_by), lte(runs.lock_expires_at, now)),
        eq(
          runs.run_id,
          sql`(SELECT ${runs.run_id} FROM ${runs} WHERE (${runs.status} = 'pending' OR (${runs.status} = 'waiting' AND ${runs.wake_at} <= ${now})) AND (${runs.locked_by} IS NULL OR ${runs.lock_expires_at} <= ${now}) LIMIT 1)`,
        ),
      ),
    )
    .returning();

  if (!result.length) return null;

  const row = result[0];
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    clog_id: row.clog_id,
    status: row.status,
    state: row.state,
    locked_by: row.locked_by,
    lock_expires_at: row.lock_expires_at,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    wake_at: row.wake_at,
    pending_input: row.pending_input,
    last_error: row.last_error,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  };
}

/**
 * Clear pending_input in the DB after acquiring the run.
 * The caller already captured the value from the acquireRun snapshot.
 * This allows applyOutcome("ok") to detect genuinely new signals
 * that arrive while the handler is executing.
 */
export async function consumePendingInput(db: SqlClient, runId: string): Promise<void> {
  await db.update(runs).set({ pending_input: null }).where(eq(runs.run_id, runId));
}

/**
 * Atomically acquire a run AND clear its pending_input.
 * Uses a SAVEPOINT so no signalRun can interleave between acquire
 * and consume. Savepoints nest safely (unlike BEGIN which fails
 * inside an existing transaction).
 */
export async function acquireAndConsumeRun(
  db: SqlClient,
  instanceId: string,
  lockMs: number,
): Promise<RunRow | null> {
  await db.run(sql`SAVEPOINT acquire_consume`);
  try {
    const run = await acquireRun(db, instanceId, lockMs);
    if (run && run.pending_input != null) {
      await consumePendingInput(db, run.run_id);
    }
    await db.run(sql`RELEASE SAVEPOINT acquire_consume`);
    return run;
  } catch (e) {
    await db.run(sql`ROLLBACK TO SAVEPOINT acquire_consume`);
    throw e;
  }
}

export async function releaseRun(
  db: SqlClient,
  runId: string,
  patch: {
    status: string;
    attempt?: number;
    wake_at?: number | null;
    last_error?: string | null;
    pending_input?: unknown;
  },
): Promise<void> {
  const sets: Record<string, unknown> = {
    locked_by: null,
    lock_expires_at: null,
    status: patch.status,
    updated_ts: nowMs(),
  };

  if (patch.attempt !== undefined) sets.attempt = patch.attempt;
  if (patch.wake_at !== undefined) sets.wake_at = patch.wake_at;
  if (patch.last_error !== undefined) sets.last_error = patch.last_error;
  if (patch.pending_input !== undefined) sets.pending_input = patch.pending_input;

  await db.update(runs).set(sets).where(eq(runs.run_id, runId));
}

/**
 * Atomic release that checks for signals in a single UPDATE (no TOCTOU race).
 *
 * If `pending_input IS NOT NULL` (signal arrived during processing):
 *   status="pending", attempt=0, wake_at=null, last_error=null, pending_input kept.
 * Otherwise: apply the `noSignal` values.
 *
 * pending_input_json must be pre-serialized JSON text (or null for SQL NULL)
 * because we mix raw SQL CASE expressions with Drizzle's json-mode column.
 */
export async function releaseRunAtomic(
  db: SqlClient,
  runId: string,
  noSignal: {
    status: string;
    attempt: number;
    wake_at: number | null;
    last_error: string | null;
    pending_input_json: string | null;
  },
): Promise<void> {
  const now = nowMs();
  await db.run(sql`
    UPDATE runs SET
      locked_by       = NULL,
      lock_expires_at = NULL,
      updated_ts      = ${now},
      status          = CASE WHEN pending_input IS NOT NULL THEN 'pending'          ELSE ${noSignal.status} END,
      attempt         = CASE WHEN pending_input IS NOT NULL THEN 0                  ELSE ${noSignal.attempt} END,
      wake_at         = CASE WHEN pending_input IS NOT NULL THEN NULL               ELSE ${noSignal.wake_at} END,
      last_error      = CASE WHEN pending_input IS NOT NULL THEN NULL               ELSE ${noSignal.last_error} END,
      pending_input   = CASE WHEN pending_input IS NOT NULL THEN pending_input      ELSE ${noSignal.pending_input_json} END
    WHERE run_id = ${runId}
  `);
}

export async function deleteRunEntity(db: SqlClient, runId: string): Promise<void> {
  // Cascades: ticks + run storage + tick storage
  await db.delete(runs).where(eq(runs.run_id, runId));
}

export async function deleteSessionEntity(db: SqlClient, sessionId: string): Promise<void> {
  // Cascades: runs + ticks + storage_session + storage_run + storage_tick
  await db.delete(oceanSessions).where(eq(oceanSessions.session_id, sessionId));
}
