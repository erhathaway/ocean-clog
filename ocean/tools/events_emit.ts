import type { SqlClient } from "../db/db.js";
import { emitEvent } from "../engine/events.js";
import type { EventScope } from "../engine/events.js";

export type EventsEmitInput = { scope: EventScope; type: string; payload: unknown };
export type EventsEmitOutput = { ok: true };

export async function toolEventsEmit(db: SqlClient, input: EventsEmitInput): Promise<EventsEmitOutput> {
  await emitEvent(db, input.scope, input.type, input.payload);
  return { ok: true };
}