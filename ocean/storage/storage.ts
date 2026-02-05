import { and, eq, inArray } from "drizzle-orm";
import type { SqlClient } from "../db/db.js";
import { nowMs } from "../core/time.js";
import { oceanStorageGlobal, oceanStorageRun, oceanStorageSession, oceanStorageTick } from "../db/schema.js";

export async function readGlobal(db: SqlClient, clogId: string): Promise<unknown | undefined> {
  const rows = await db
    .select({ value: oceanStorageGlobal.value })
    .from(oceanStorageGlobal)
    .where(eq(oceanStorageGlobal.clog_id, clogId))
    .limit(1);
  return rows[0]?.value ?? undefined;
}

export async function upsertGlobal(db: SqlClient, clogId: string, value: unknown): Promise<void> {
  await db
    .insert(oceanStorageGlobal)
    .values({ clog_id: clogId, value, updated_ts: nowMs() })
    .onConflictDoUpdate({
      target: oceanStorageGlobal.clog_id,
      set: { value, updated_ts: nowMs() },
    });
}

export async function deleteGlobalRow(db: SqlClient, clogId: string): Promise<void> {
  await db.delete(oceanStorageGlobal).where(eq(oceanStorageGlobal.clog_id, clogId));
}

export async function readSession(db: SqlClient, clogId: string, sessionId: string): Promise<unknown | undefined> {
  const rows = await db
    .select({ value: oceanStorageSession.value })
    .from(oceanStorageSession)
    .where(and(eq(oceanStorageSession.clog_id, clogId), eq(oceanStorageSession.session_id, sessionId)))
    .limit(1);
  return rows[0]?.value ?? undefined;
}

export async function upsertSession(db: SqlClient, clogId: string, sessionId: string, value: unknown): Promise<void> {
  await db
    .insert(oceanStorageSession)
    .values({ clog_id: clogId, session_id: sessionId, value, updated_ts: nowMs() })
    .onConflictDoUpdate({
      target: [oceanStorageSession.clog_id, oceanStorageSession.session_id],
      set: { value, updated_ts: nowMs() },
    });
}

export async function deleteSessionStorageRow(db: SqlClient, clogId: string, sessionId: string): Promise<void> {
  // Deletes only this clog's session storage row, NOT the session entity.
  await db
    .delete(oceanStorageSession)
    .where(and(eq(oceanStorageSession.clog_id, clogId), eq(oceanStorageSession.session_id, sessionId)));
}

export async function readRun(db: SqlClient, clogId: string, runId: string): Promise<unknown | undefined> {
  const rows = await db
    .select({ value: oceanStorageRun.value })
    .from(oceanStorageRun)
    .where(and(eq(oceanStorageRun.clog_id, clogId), eq(oceanStorageRun.run_id, runId)))
    .limit(1);
  return rows[0]?.value ?? undefined;
}

export async function upsertRun(db: SqlClient, clogId: string, runId: string, value: unknown): Promise<void> {
  await db
    .insert(oceanStorageRun)
    .values({ clog_id: clogId, run_id: runId, value, updated_ts: nowMs() })
    .onConflictDoUpdate({
      target: [oceanStorageRun.clog_id, oceanStorageRun.run_id],
      set: { value, updated_ts: nowMs() },
    });
}

export async function deleteRunStorageRow(db: SqlClient, clogId: string, runId: string): Promise<void> {
  // Deletes only this clog's run storage row, NOT the run entity.
  await db
    .delete(oceanStorageRun)
    .where(and(eq(oceanStorageRun.clog_id, clogId), eq(oceanStorageRun.run_id, runId)));
}

export async function readTickRows(
  db: SqlClient,
  clogId: string,
  runId: string,
  tickId: string,
  rowIds: string[],
): Promise<Record<string, unknown>> {
  if (rowIds.length === 0) return {};
  const rows = await db
    .select({ row_id: oceanStorageTick.row_id, value: oceanStorageTick.value })
    .from(oceanStorageTick)
    .where(
      and(
        eq(oceanStorageTick.clog_id, clogId),
        eq(oceanStorageTick.run_id, runId),
        eq(oceanStorageTick.tick_id, tickId),
        inArray(oceanStorageTick.row_id, rowIds),
      ),
    );

  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.row_id] = row.value;
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
  await db
    .insert(oceanStorageTick)
    .values({ clog_id: clogId, run_id: runId, tick_id: tickId, row_id: rowId, value, updated_ts: nowMs() })
    .onConflictDoUpdate({
      target: [oceanStorageTick.clog_id, oceanStorageTick.run_id, oceanStorageTick.tick_id, oceanStorageTick.row_id],
      set: { value, updated_ts: nowMs() },
    });
}

export async function deleteTickRow(
  db: SqlClient,
  clogId: string,
  runId: string,
  tickId: string,
  rowId: string,
): Promise<void> {
  await db
    .delete(oceanStorageTick)
    .where(
      and(
        eq(oceanStorageTick.clog_id, clogId),
        eq(oceanStorageTick.run_id, runId),
        eq(oceanStorageTick.tick_id, tickId),
        eq(oceanStorageTick.row_id, rowId),
      ),
    );
}
