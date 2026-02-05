export type StorageReadPlan =
  | { kind: "global" }                               // reads clog global row
  | { kind: "session"; sessionId: string }           // reads clog session row
  | { kind: "run"; runId: string }                   // reads clog run row
  | { kind: "tick_rows"; runId: string; tickId: string; rowIds: string[] } // reads exact tick rows
  | { kind: "history_ticks_for_run"; runId: string; rowIds?: string[]; limitTicks?: number; order?: "asc" | "desc" }; // bulk hydration, no unlock

export type ReadScopedInput = {
  plans: StorageReadPlan[];
};

export type ReadScopedOutput = {
  ok: true;
  snapshot: Array<
    | { type: "global"; value?: unknown }
    | { type: "session"; sessionId: string; value?: unknown }
    | { type: "run"; runId: string; value?: unknown }
    | { type: "tick_rows"; runId: string; tickId: string; rows: Record<string, unknown> } // rowId->value
    | { type: "history_ticks"; runId: string; ticks: Array<{ tickId: string; updatedTs: number; rows: Record<string, unknown> }> }
  >;
};