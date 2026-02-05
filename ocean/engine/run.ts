import { eq } from "drizzle-orm";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";
import { oceanSessions, runs } from "../db/schema.js";

export type RunRow = {
  run_id: string;
  session_id: string;
  status: string;
  state: unknown;
  created_ts: number;
  updated_ts: number;
};

export async function createSessionIfMissing(db: SqlClient, sessionId: string): Promise<void> {
  await db
    .insert(oceanSessions)
    .values({ session_id: sessionId, created_ts: nowMs() })
    .onConflictDoNothing();
}

export async function createRun(db: SqlClient, runId: string, sessionId: string, initialState: unknown): Promise<void> {
  await createSessionIfMissing(db, sessionId);
  await db.insert(runs).values({
    run_id: runId,
    created_ts: nowMs(),
    updated_ts: nowMs(),
    session_id: sessionId,
    status: "queued",
    state: initialState,
  });
}

export async function getRun(db: SqlClient, runId: string): Promise<RunRow | null> {
  const rows = await db.select().from(runs).where(eq(runs.run_id, runId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    status: row.status,
    state: row.state,
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  };
}

export async function updateRunState(db: SqlClient, runId: string, patch: Partial<{ status: string; state: unknown }>): Promise<void> {
  const sets: Partial<{ status: string; state: unknown; updated_ts: number }> = {
    updated_ts: nowMs(),
  };

  if (patch.status !== undefined) {
    sets.status = patch.status;
  }
  if (patch.state !== undefined) {
    sets.state = patch.state;
  }

  await db.update(runs).set(sets).where(eq(runs.run_id, runId));
}

export async function deleteRunEntity(db: SqlClient, runId: string): Promise<void> {
  // Cascades: ticks + run storage + tick storage
  await db.delete(runs).where(eq(runs.run_id, runId));
}

export async function deleteSessionEntity(db: SqlClient, sessionId: string): Promise<void> {
  // Cascades: runs + ticks + storage_session + storage_run + storage_tick
  await db.delete(oceanSessions).where(eq(oceanSessions.session_id, sessionId));
}
