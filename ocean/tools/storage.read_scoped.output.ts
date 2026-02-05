export type ReadScopedOutput = {
  ok: true;
  snapshot: Array<
    | { type: "kv"; scope: StorageScopeRef; values: Record<string, unknown> }
    | { type: "list_keys"; scope: StorageScopeRef; keys: string[] }
    | {
        type: "history_ticks";
        runId: string;
        ticks: Array<{
          tickId: string;
          updatedTs: number;
          values: Record<string, unknown>;
        }>;
      }
  >;
};