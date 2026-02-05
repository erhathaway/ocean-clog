export type StorageSessionReadInput =
  | { op: "get"; sessionId: string; key: string }
  | { op: "list"; sessionId: string; prefix?: string };

export type StorageSessionReadOutput =
  | { ok: true; op: "get"; sessionId: string; key: string; value?: unknown }
  | { ok: true; op: "list"; sessionId: string; keys: string[] };

export type StorageSessionWriteInput =
  | { op: "set"; sessionId: string; key: string; value: unknown }
  | { op: "del"; sessionId: string; key: string };