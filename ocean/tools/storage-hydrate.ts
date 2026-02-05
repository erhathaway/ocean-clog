export type StorageHydrateInput = {
  sessionId?: string; // optional override; usually derived from runId
  runId?: string;
  tickId?: string;

  keys?: {
    global?: string[];
    session?: string[];
    run?: string[];
    tick?: string[];
  };

  // If omitted, Ocean can treat it as:
  // - read "presence" (list) in each requested scope, OR
  // - read nothing but still mark RBW (I recommend: do at least a list)
  include?: Array<"global" | "session" | "run" | "tick">;
};

export type StorageHydrateOutput = {
  ok: true;
  snapshot: {
    global?: Record<string, unknown>;
    session?: Record<string, unknown>;
    run?: Record<string, unknown>;
    tick?: Record<string, unknown>;
  };
};