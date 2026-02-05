import { sql } from "drizzle-orm";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";

export async function beginTickEntity(db: SqlClient, runId: string, tickId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO ocean_ticks(run_id, tick_id, created_ts)
        VALUES (${runId}, ${tickId}, ${nowMs()})
        ON CONFLICT(run_id, tick_id) DO NOTHING`,
  );
}

export async function deleteTickEntity(db: SqlClient, runId: string, tickId: string): Promise<void> {
  // Cascades: tick storage rows
  await db.execute(sql`DELETE FROM ocean_ticks WHERE run_id = ${runId} AND tick_id = ${tickId}`);
}
