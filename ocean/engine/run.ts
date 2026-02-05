import { sql } from "drizzle-orm";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";

export type RunRow = {
  run_id: string;
  session_id: string;
  status: string;
  state: unknown;
  created_ts: number;
  updated_ts: number;
};

function firstRow(result: any): any | null {
  if (Array.isArray(result)) return result[0] ?? null;
  if (result?.rows && Array.isArray(result.rows)) return result.rows[0] ?? null;
  return null;
}

export async function createSessionIfMissing(db: SqlClient, sessionId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_sessions(session_id, created_ts)
        VALUES (${sessionId}, ${nowMs()})
        ON CONFLICT(session_id) DO NOTHING`,
  );
}

export async function createRun(db: SqlClient, runId: string, sessionId: string, initialState: unknown): Promise<void> {
  await createSessionIfMissing(db, sessionId);
  await db.execute(
    sql`INSERT INTO runs(run_id, created_ts, updated_ts, session_id, status, state)
        VALUES (${runId}, ${nowMs()}, ${nowMs()}, ${sessionId}, ${"queued"}, ${JSON.stringify(initialState)})`,
  );
}

export async function getRun(db: SqlClient, runId: string): Promise<RunRow | null> {
  const r = await db.execute(sql`SELECT * FROM runs WHERE run_id = ${runId}`);
  const row = firstRow(r);
  if (!row) return null;
  return {
    run_id: row.run_id,
    session_id: row.session_id,
    status: row.status,
    state: JSON.parse(row.state),
    created_ts: row.created_ts,
    updated_ts: row.updated_ts,
  };
}

export async function updateRunState(db: SqlClient, runId: string, patch: Partial<{ status: string; state: unknown }>): Promise<void> {
  const sets = [];

  if (patch.status !== undefined) {
    sets.push(sql`status = ${patch.status}`);
  }
  if (patch.state !== undefined) {
    sets.push(sql`state = ${JSON.stringify(patch.state)}`);
  }

  sets.push(sql`updated_ts = ${nowMs()}`);

  await db.execute(sql`UPDATE runs SET ${sql.join(sets, sql`, `)} WHERE run_id = ${runId}`);
}

export async function deleteRunEntity(db: SqlClient, runId: string): Promise<void> {
  // Cascades: ticks + run storage + tick storage
  await db.execute(sql`DELETE FROM runs WHERE run_id = ${runId}`);
}

export async function deleteSessionEntity(db: SqlClient, sessionId: string): Promise<void> {
  // Cascades: runs + ticks + storage_session + storage_run + storage_tick
  await db.execute(sql`DELETE FROM ocean_sessions WHERE session_id = ${sessionId}`);
}
