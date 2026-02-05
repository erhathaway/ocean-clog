export type StorageRunReadInput =
  | { op: "get"; runId: string; key: string }
  | { op: "list"; runId: string; prefix?: string };

export type StorageRunReadOutput =
  | { ok: true; op: "get"; runId: string; key: string; value?: unknown }
  | { ok: true; op: "list"; runId: string; keys: string[] };

export type StorageRunWriteInput =
  | { op: "set"; runId: string; key: string; value: unknown }
  | { op: "del"; runId: string; key: string };