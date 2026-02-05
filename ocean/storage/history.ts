import { and, asc, desc, eq, inArray, max } from "drizzle-orm";
import type { SqlClient } from "../db/db.js";
import { oceanStorageTick } from "../db/schema.js";

export async function readTickHistoryForRun(
  db: SqlClient,
  clogId: string,
  runId: string,
  rowIds: string[] | undefined,
  limitTicks: number,
  order: "asc" | "desc",
): Promise<Array<{ tickId: string; updatedTs: number; rows: Record<string, unknown> }>> {
  const ticks = await db
    .select({
      tickId: oceanStorageTick.tick_id,
      updatedTs: max(oceanStorageTick.updated_ts),
    })
    .from(oceanStorageTick)
    .where(and(eq(oceanStorageTick.clog_id, clogId), eq(oceanStorageTick.run_id, runId)))
    .groupBy(oceanStorageTick.tick_id)
    .orderBy(order === "asc" ? asc(max(oceanStorageTick.updated_ts)) : desc(max(oceanStorageTick.updated_ts)))
    .limit(limitTicks);
  if (ticks.length === 0) return [];

  const tickIds = ticks.map((t) => t.tickId);
  const where = [
    eq(oceanStorageTick.clog_id, clogId),
    eq(oceanStorageTick.run_id, runId),
    inArray(oceanStorageTick.tick_id, tickIds),
  ];
  if (rowIds && rowIds.length > 0) {
    where.push(inArray(oceanStorageTick.row_id, rowIds));
  }

  const rows = await db
    .select({
      tickId: oceanStorageTick.tick_id,
      rowId: oceanStorageTick.row_id,
      value: oceanStorageTick.value,
    })
    .from(oceanStorageTick)
    .where(and(...where));

  const byTick: Record<string, { updatedTs: number; rows: Record<string, unknown> }> = {};
  for (const t of ticks) byTick[t.tickId] = { updatedTs: t.updatedTs ?? 0, rows: {} };

  for (const row of rows) {
    if (!byTick[row.tickId]) byTick[row.tickId] = { updatedTs: 0, rows: {} };
    byTick[row.tickId].rows[row.rowId] = row.value;
  }

  return tickIds.map((id) => ({ tickId: id, updatedTs: byTick[id].updatedTs, rows: byTick[id].rows }));
}
