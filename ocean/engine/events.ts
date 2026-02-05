import { lt } from "drizzle-orm";
import { randomId } from "../core/ids.js";
import { nowMs } from "../core/time.js";
import type { SqlClient } from "../db/db.js";
import { events } from "../db/schema.js";

export type EventScope =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string; sessionId?: string }
  | { kind: "tick"; runId: string; tickId: string; sessionId?: string };

export async function emitEvent(db: SqlClient, scope: EventScope, type: string, payload: unknown): Promise<void> {
  const id = randomId("evt");
  const ts = nowMs();

  const scope_kind = scope.kind;
  const session_id =
    scope.kind === "session"
      ? scope.sessionId
      : scope.kind === "run" || scope.kind === "tick"
        ? scope.sessionId ?? null
        : null;
  const run_id = scope.kind === "run" || scope.kind === "tick" ? scope.runId : null;
  const tick_id = scope.kind === "tick" ? scope.tickId : null;

  await db.insert(events).values({
    id,
    ts,
    scope_kind,
    session_id,
    run_id,
    tick_id,
    type,
    payload,
  });
}

export async function gcEventsByTtl(db: SqlClient, ttlMs: number): Promise<number> {
  const cutoff = nowMs() - ttlMs;
  const res: any = await db.delete(events).where(lt(events.ts, cutoff));
  return res?.changes ?? res?.rowsAffected ?? res?.rowCount ?? 0;
}
