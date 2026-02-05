export type StorageGlobalReadInput =
  | { op: "get"; key: string }
  | { op: "list"; prefix?: string };

export type StorageGlobalReadOutput =
  | { ok: true; op: "get"; key: string; value?: unknown }
  | { ok: true; op: "list"; keys: string[] };

export type StorageGlobalWriteInput =
  | { op: "set"; key: string; value: unknown }
  | { op: "del"; key: string };

export type StorageWriteOutput = { ok: true };