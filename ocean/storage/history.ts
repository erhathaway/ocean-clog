import { sql } from "drizzle-orm";
import type { SqlClient } from "../db/db.js";

export async function readTickHistoryForRun(
  db: SqlClient,
  clogId: string,
  runId: string,
  rowIds: string[] | undefined,
  limitTicks: number,
  order: "asc" | "desc",
): Promise<Array<{ tickId: string; updatedTs: number; rows: Record<string, unknown> }>> {
  const orderSql = order === "asc" ? sql.raw("ASC") : sql.raw("DESC");
  const r1: any = await db.execute(sql`
    SELECT tick_id as tickId, MAX(updated_ts) as updatedTs
    FROM ocean_storage_tick
    WHERE clog_id = ${clogId} AND run_id = ${runId}
    GROUP BY tick_id
    ORDER BY updatedTs ${orderSql}
    LIMIT ${limitTicks}
  `);

  const ticks = Array.isArray(r1) ? r1 : (r1?.rows ?? []);
  if (ticks.length === 0) return [];

  const tickIds = ticks.map((t: any) => t.tickId);
  const rowFilter =
    rowIds && rowIds.length > 0
      ? sql`AND row_id IN (${sql.join(rowIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;

  const r2: any = await db.execute(sql`
    SELECT tick_id as tickId, row_id as rowId, value
    FROM ocean_storage_tick
    WHERE clog_id = ${clogId} AND run_id = ${runId}
      AND tick_id IN (${sql.join(tickIds.map((id) => sql`${id}`), sql`, `)})
      ${rowFilter}
  `);
  const rows = Array.isArray(r2) ? r2 : (r2?.rows ?? []);

  const byTick: Record<string, { updatedTs: number; rows: Record<string, unknown> }> = {};
  for (const t of ticks) byTick[t.tickId] = { updatedTs: t.updatedTs, rows: {} };

  for (const row of rows) {
    if (!byTick[row.tickId]) byTick[row.tickId] = { updatedTs: 0, rows: {} };
    byTick[row.tickId].rows[row.rowId] = JSON.parse(row.value);
  }

  return tickIds.map((id: string) => ({ tickId: id, updatedTs: byTick[id].updatedTs, rows: byTick[id].rows }));
}
