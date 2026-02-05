export type StorageTickReadInput =
  | { op: "get"; runId: string; tickId: string; key: string }
  | { op: "list"; runId: string; tickId: string; prefix?: string };

export type StorageTickReadOutput =
  | { ok: true; op: "get"; runId: string; tickId: string; key: string; value?: unknown }
  | { ok: true; op: "list"; runId: string; tickId: string; keys: string[] };

export type StorageTickWriteInput =
  | { op: "set"; runId: string; tickId: string; key: string; value: unknown }
  | { op: "del"; runId: string; tickId: string; key: string };

export type StorageTickClearInput = { runId: string; tickId: string };