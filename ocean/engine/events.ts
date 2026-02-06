import { and, asc, eq, gt, lt } from "drizzle-orm";
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

export type ReadEventsScope =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string };

export type EventRow = {
  seq: number;
  id: string;
  ts: number;
  scope_kind: string;
  session_id: string | null;
  run_id: string | null;
  tick_id: string | null;
  type: string;
  payload: unknown;
};

export async function readEventsByScope(
  db: SqlClient,
  scope: ReadEventsScope,
  afterSeq: number,
  limit: number,
): Promise<EventRow[]> {
  const conditions = [gt(events.seq, afterSeq)];

  if (scope.kind === "global") {
    conditions.push(eq(events.scope_kind, "global"));
  } else if (scope.kind === "session") {
    conditions.push(eq(events.session_id, scope.sessionId));
  } else if (scope.kind === "run") {
    conditions.push(eq(events.run_id, scope.runId));
  }

  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(asc(events.seq))
    .limit(limit);

  return rows.map((r) => ({
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    scope_kind: r.scope_kind,
    session_id: r.session_id,
    run_id: r.run_id,
    tick_id: r.tick_id,
    type: r.type,
    payload: r.payload,
  }));
}

export async function gcEventsByTtl(db: SqlClient, ttlMs: number): Promise<number> {
  const cutoff = nowMs() - ttlMs;
  const res: any = await db.delete(events).where(lt(events.ts, cutoff));
  return res?.changes ?? res?.rowsAffected ?? res?.rowCount ?? 0;
}
