export type StorageWriteOp =
  | { op: "set"; scope: StorageScopeRef; key: string; value: unknown }
  | { op: "del"; scope: StorageScopeRef; key: string }
  | { op: "tick.clear"; scope: { kind: "tick"; runId: string; tickId: string } };

export type WriteScopedInput = {
  ops: StorageWriteOp[];
};

export type WriteScopedOutput = {
  ok: true;
  applied: number;
};