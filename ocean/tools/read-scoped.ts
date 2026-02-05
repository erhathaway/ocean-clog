export type StorageScopeRef =
  | { kind: "global" }
  | { kind: "session"; sessionId: string }
  | { kind: "run"; runId: string }
  | { kind: "tick"; runId: string; tickId: string };

export type StorageReadPlan = {
  scope: StorageScopeRef;
  keys?: string[];         // if omitted, read nothing but DO NOT unlock; recommended: require keys
  listPrefix?: string;     // optional alternative to keys
};

export type ReadScopedInput = {
  plans: StorageReadPlan[];
};

export type ReadScopedOutput = {
  ok: true;
  snapshot: Array<{
    scope: StorageScopeRef;
    values?: Record<string, unknown>; // key -> value (missing keys omitted)
    keys?: string[];                  // if listPrefix used
  }>;
};