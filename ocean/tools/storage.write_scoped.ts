export type StorageWriteOp =
  | { op: "global.set"; value: unknown }
  | { op: "global.clear" }
  | { op: "session.set"; sessionId: string; value: unknown }
  | { op: "session.clear"; sessionId: string }
  | { op: "run.set"; runId: string; value: unknown }
  | { op: "run.clear"; runId: string }
  | { op: "tick.set"; runId: string; tickId: string; rowId: string; value: unknown }
  | { op: "tick.del"; runId: string; tickId: string; rowId: string };

export type WriteScopedInput = { ops: StorageWriteOp[] };

export type WriteScopedOutput = { ok: true; applied: number };