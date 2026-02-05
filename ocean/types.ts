export type OceanScope =
  | { kind: "global" }
  | { kind: "session"; id: string }
  | { kind: "run"; id: string };

export type RunStep =
  | { kind: "agent"; agentId: string; input?: unknown }
  | { kind: "capability"; capability: string; action: string; args?: unknown }
  | { kind: "delay"; ms: number };

export type RunSpec = {
  sessionId: string;
  chain: RunStep[];
  input?: unknown;
};

export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed" | "cancelled";

export type RunState = {
  chain: RunStep[];
  stepIndex: number;
  stepState?: unknown;     // resumable state for the *current* step
  lastOutput?: unknown;    // output from most recently completed step
  input?: unknown;         // initial input
};

export type OceanEventType =
  | "run.started"
  | "run.delta"
  | "run.step.completed"
  | "run.waiting"
  | "run.final"
  | "run.error"
  | "run.cancelled";

export type OceanEventEnvelope<TPayload = unknown> = {
  id: string;      // uuid
  ts: number;      // epoch ms
  scope: OceanScope;
  type: OceanEventType | (string & {});
  payload: TPayload;
};

export type OceanEventRow = {
  seq: number;
  id: string;
  ts: number;
  scope_kind: "global" | "session" | "run";
  scope_id: string | null;
  type: string;
  payload: unknown;
};

export type OceanTickResult = {
  didWork: boolean;
  ranCount: number;
};

export type OceanDb = {
  // Minimal DB interface: implement with libsql client or any SQLite provider.
  execute: (sql: string, args?: unknown[]) => Promise<{
    rows?: Array<Record<string, unknown>>;
    rowsAffected?: number;
    lastInsertRowid?: number | string;
  }>;
};

export type OceanLogger = {
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

export type OceanOptions = {
  db: OceanDb;
  instanceId?: string;          // used for run leases
  logger?: OceanLogger;

  // Streaming delta write coalescing (reduce DB writes)
  deltaFlushMs?: number;        // default 100
  deltaMaxChars?: number;       // default 2000

  // Lease safety for concurrent invocations (serverless)
  leaseMs?: number;             // default 30_000
};

export type AgentContext = {
  now: () => number;
  emitDelta: (chunk: string) => Promise<void>;
  getStepState: () => unknown;
  setStepState: (next: unknown) => Promise<void>;
  budgetMs: number;             // <= 30s
};

export type AgentResult =
  | { type: "complete"; output?: unknown }
  | { type: "waiting"; wakeTs: number }
  | { type: "error"; error: string };

export type AgentHandler = (input: unknown, ctx: AgentContext) => Promise<AgentResult>;

export type CapabilityContext = {
  now: () => number;
  getStepState: () => unknown;
  setStepState: (next: unknown) => Promise<void>;
  budgetMs: number;
};

export type CapabilityResult =
  | { type: "complete"; output?: unknown }
  | { type: "waiting"; wakeTs: number }
  | { type: "error"; error: string };

export type CapabilityHandler = (params: {
  action: string;
  args?: unknown;
  input: unknown;
  ctx: CapabilityContext;
}) => Promise<CapabilityResult>;

export type Ocean = {
  migrate: () => Promise<void>;

  registerAgent: (agentId: string, handler: AgentHandler) => void;
  registerCapability: (capability: string, handler: CapabilityHandler) => void;

  startRun: (spec: RunSpec) => Promise<{ runId: string }>;
  cancelRun: (runId: string, sessionId?: string) => Promise<void>;

  tick: (opts?: { budgetMs?: number; maxRuns?: number; stepBudgetMs?: number }) => Promise<OceanTickResult>;

  readEvents: (opts: { scope: OceanScope; afterSeq: number; limit?: number }) => Promise<OceanEventRow[]>;
};