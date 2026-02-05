export type EventsEmitInput = {
  scope:
    | { kind: "global" }
    | { kind: "session"; id: string }
    | { kind: "run"; id: string }
    | { kind: "tick"; runId: string; tickId: string };
  type: string;
  payload: unknown;
};

export type EventsEmitOutput = { ok: true };