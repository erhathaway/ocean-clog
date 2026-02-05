import { and, eq } from "drizzle-orm";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";
import { oceanTicks } from "../db/schema.js";

export async function beginTickEntity(db: SqlClient, runId: string, tickId: string): Promise<void> {
  await db
    .insert(oceanTicks)
    .values({ run_id: runId, tick_id: tickId, created_ts: nowMs() })
    .onConflictDoNothing();
}

export async function deleteTickEntity(db: SqlClient, runId: string, tickId: string): Promise<void> {
  // Cascades: tick storage rows
  await db
    .delete(oceanTicks)
    .where(and(eq(oceanTicks.run_id, runId), eq(oceanTicks.tick_id, tickId)));
}
