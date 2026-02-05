import { sql } from "drizzle-orm";
import type { SqlClient } from "../db/db.js";
import { nowMs } from "../core/time.js";

function firstRow(result: any): any | null {
  if (Array.isArray(result)) return result[0] ?? null;
  if (result?.rows && Array.isArray(result.rows)) return result.rows[0] ?? null;
  return null;
}

export async function readGlobal(db: SqlClient, clogId: string): Promise<unknown | undefined> {
  const r = await db.execute(sql`SELECT value FROM ocean_storage_global WHERE clog_id = ${clogId}`);
  const row = firstRow(r);
  return row ? JSON.parse(row.value) : undefined;
}

export async function upsertGlobal(db: SqlClient, clogId: string, value: unknown): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_storage_global(clog_id, value, updated_ts)
        VALUES (${clogId}, ${JSON.stringify(value)}, ${nowMs()})
        ON CONFLICT(clog_id) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`,
  );
}

export async function deleteGlobalRow(db: SqlClient, clogId: string): Promise<void> {
  await db.execute(sql`DELETE FROM ocean_storage_global WHERE clog_id = ${clogId}`);
}

export async function readSession(db: SqlClient, clogId: string, sessionId: string): Promise<unknown | undefined> {
  const r = await db.execute(
    sql`SELECT value FROM ocean_storage_session WHERE clog_id = ${clogId} AND session_id = ${sessionId}`,
  );
  const row = firstRow(r);
  return row ? JSON.parse(row.value) : undefined;
}

export async function upsertSession(db: SqlClient, clogId: string, sessionId: string, value: unknown): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_storage_session(clog_id, session_id, value, updated_ts)
        VALUES (${clogId}, ${sessionId}, ${JSON.stringify(value)}, ${nowMs()})
        ON CONFLICT(clog_id, session_id) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`,
  );
}

export async function deleteSessionStorageRow(db: SqlClient, clogId: string, sessionId: string): Promise<void> {
  // Deletes only this clog's session storage row, NOT the session entity.
  await db.execute(
    sql`DELETE FROM ocean_storage_session WHERE clog_id = ${clogId} AND session_id = ${sessionId}`,
  );
}

export async function readRun(db: SqlClient, clogId: string, runId: string): Promise<unknown | undefined> {
  const r = await db.execute(
    sql`SELECT value FROM ocean_storage_run WHERE clog_id = ${clogId} AND run_id = ${runId}`,
  );
  const row = firstRow(r);
  return row ? JSON.parse(row.value) : undefined;
}

export async function upsertRun(db: SqlClient, clogId: string, runId: string, value: unknown): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_storage_run(clog_id, run_id, value, updated_ts)
        VALUES (${clogId}, ${runId}, ${JSON.stringify(value)}, ${nowMs()})
        ON CONFLICT(clog_id, run_id) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`,
  );
}

export async function deleteRunStorageRow(db: SqlClient, clogId: string, runId: string): Promise<void> {
  // Deletes only this clog's run storage row, NOT the run entity.
  await db.execute(sql`DELETE FROM ocean_storage_run WHERE clog_id = ${clogId} AND run_id = ${runId}`);
}

export async function readTickRows(
  db: SqlClient,
  clogId: string,
  runId: string,
  tickId: string,
  rowIds: string[],
): Promise<Record<string, unknown>> {
  if (rowIds.length === 0) return {};
  const r: any = await db.execute(sql`
    SELECT row_id, value
    FROM ocean_storage_tick
    WHERE clog_id = ${clogId} AND run_id = ${runId} AND tick_id = ${tickId}
      AND row_id IN (${sql.join(rowIds.map((id) => sql`${id}`), sql`, `)})
  `);

  const rows = Array.isArray(r) ? r : (r?.rows ?? []);
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.row_id] = JSON.parse(row.value);
  return out;
}

export async function upsertTickRow(
  db: SqlClient,
  clogId: string,
  runId: string,
  tickId: string,
  rowId: string,
  value: unknown,
): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_storage_tick(clog_id, run_id, tick_id, row_id, value, updated_ts)
        VALUES (${clogId}, ${runId}, ${tickId}, ${rowId}, ${JSON.stringify(value)}, ${nowMs()})
        ON CONFLICT(clog_id, run_id, tick_id, row_id) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`,
  );
}

export async function deleteTickRow(
  db: SqlClient,
  clogId: string,
  runId: string,
  tickId: string,
  rowId: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM ocean_storage_tick
        WHERE clog_id = ${clogId} AND run_id = ${runId} AND tick_id = ${tickId} AND row_id = ${rowId}`,
  );
}
