import type { SqlClient } from "./db/db.js";
import { enableForeignKeys } from "./db/db.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Clog, TickOutcome } from "./clogs/types.js";
import { ClogRegistry } from "./clogs/registry.js";
import { createRun, getRun, signalRun, acquireRun, releaseRun, consumePendingInput } from "./engine/run.js";
import type { RunRow } from "./engine/run.js";
import { beginTickEntity } from "./engine/tick.js";
import { randomId } from "./core/ids.js";
import { nowMs } from "./core/time.js";
import { gcEventsByTtl, readEventsByScope } from "./engine/events.js";
import type { ReadEventsScope, EventRow } from "./engine/events.js";
import { createToolInvoker } from "./clogs/runtime.js";

export type OceanOptions = {
  db: SqlClient;

  instanceId?: string;
  lockMs?: number;

  // audit log retention
  eventsTtlMs?: number;
  eventsGcMinIntervalMs?: number;
};

export type AdvanceResult = {
  advanced: number;
  results: Array<{ runId: string; outcome: string }>;
};

export type RunInfo = {
  runId: string;
  sessionId: string;
  clogId: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  wakeAt: number | null;
  lastError: string | null;
  createdTs: number;
  updatedTs: number;
};

export type Ocean = {
  migrate: () => Promise<void>;
  registerClog: (clog: Clog) => void;

  createRun: (args: {
    sessionId: string;
    clogId: string;
    input?: unknown;
    initialState?: unknown;
    retry?: { maxAttempts?: number };
  }) => Promise<{ runId: string }>;
  beginTick: (args: { runId: string; tickId?: string }) => Promise<{ tickId: string }>;

  callClog: (args: { runId: string; tickId: string; clogId: string; method: string; payload?: unknown }) => Promise<unknown>;

  signal: (runId: string, input?: unknown) => Promise<void>;
  advance: () => Promise<AdvanceResult>;
  getRun: (runId: string) => Promise<RunInfo | null>;

  readEvents: (args: { scope: ReadEventsScope; afterSeq?: number; limit?: number }) => Promise<EventRow[]>;

  gcEventsIfDue: () => Promise<void>;
};

function runRowToInfo(row: RunRow): RunInfo {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    clogId: row.clog_id,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    wakeAt: row.wake_at,
    lastError: row.last_error,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function backoffMs(attempt: number): number {
  // exponential backoff: 1s, 2s, 4s, 8s, ... capped at 60s
  return Math.min(1000 * Math.pow(2, attempt), 60_000);
}

async function applyOutcome(db: SqlClient, run: RunRow, outcome: TickOutcome): Promise<void> {
  switch (outcome.status) {
    case "ok": {
      // pending_input was cleared by consumePendingInput() after acquireRun.
      // If non-null now, a new signal arrived during processing.
      const freshRow = await getRun(db, run.run_id);
      const hasNewInput = freshRow?.pending_input != null;
      await releaseRun(db, run.run_id, {
        status: hasNewInput ? "pending" : "idle",
        attempt: 0,
        last_error: null,
        wake_at: null,
        pending_input: hasNewInput ? undefined : null,
      });
      break;
    }
    case "done": {
      await releaseRun(db, run.run_id, {
        status: "done",
        attempt: 0,
        last_error: null,
        wake_at: null,
        pending_input: null,
      });
      break;
    }
    case "continue": {
      // Check if a new signal arrived during processing.
      // If so, the signal's input takes precedence over continue's input.
      const freshCont = await getRun(db, run.run_id);
      const hasNewContSignal = freshCont?.pending_input != null;
      await releaseRun(db, run.run_id, {
        status: "pending",
        pending_input: hasNewContSignal ? undefined : (outcome.input ?? null),
        attempt: 0,
        last_error: null,
        wake_at: null,
      });
      break;
    }
    case "wait": {
      // Check if a new signal arrived during processing.
      const freshWait = await getRun(db, run.run_id);
      const hasNewWaitInput = freshWait?.pending_input != null;
      if (hasNewWaitInput) {
        // New signal takes precedence — go to pending instead of waiting.
        await releaseRun(db, run.run_id, {
          status: "pending",
          attempt: 0,
          wake_at: null,
          last_error: null,
          pending_input: undefined, // keep signal's value in DB
        });
      } else {
        await releaseRun(db, run.run_id, {
          status: "waiting",
          attempt: 0,
          wake_at: outcome.wakeAt,
          last_error: null,
          pending_input: null,
        });
      }
      break;
    }
    case "retry": {
      const nextAttempt = run.attempt + 1;
      if (nextAttempt >= run.max_attempts) {
        await releaseRun(db, run.run_id, {
          status: "failed",
          attempt: nextAttempt,
          last_error: outcome.error,
          wake_at: null,
          pending_input: null,
        });
      } else {
        // Restore consumed input so retry gets the same input.
        // If a new signal arrived during processing, it takes precedence
        // (signalRun already wrote the new value + flipped to pending).
        const freshRow = await getRun(db, run.run_id);
        const hasNewSignal = freshRow?.pending_input != null;
        await releaseRun(db, run.run_id, {
          status: hasNewSignal ? "pending" : "waiting",
          attempt: hasNewSignal ? 0 : nextAttempt,
          wake_at: hasNewSignal ? null : nowMs() + backoffMs(nextAttempt),
          last_error: hasNewSignal ? null : outcome.error,
          pending_input: hasNewSignal ? undefined : run.pending_input,
        });
      }
      break;
    }
    case "failed": {
      await releaseRun(db, run.run_id, {
        status: "failed",
        last_error: outcome.error,
        wake_at: null,
        pending_input: null,
      });
      break;
    }
  }
}

export function createOcean(opts: OceanOptions): Ocean {
  const registry = new ClogRegistry();
  let lastGcTs = 0;
  const defaultInstanceId = opts.instanceId ?? randomId("inst");

  function toolInvokerFactoryForTickSync(args: { runId: string; tickId: string; sessionId: string }) {
    // Returns a factory that creates a fresh per-clog tool invoker (fresh 1R/1W budget).
    // When a clog calls ocean.clog.call, the callee gets its own invoker via this factory,
    // so nested clog calls each get independent read/write budgets.
    const factory = (clogId: string) => {
      const readCalled = { value: false };
      const writeCalled = { value: false };
      const ledger = {
        global: false,
        session: new Set<string>(),
        run: new Set<string>(),
        tickRows: new Set<string>(),
      };

      return createToolInvoker({
        db: opts.db,
        registry,
        tickCtx: { clogId, sessionId: args.sessionId, runId: args.runId, tickId: args.tickId },
        readCalled,
        writeCalled,
        ledger,
        toolInvokerFactory: factory,
      });
    };
    return factory;
  }

  return {
    async migrate() {
      await enableForeignKeys(opts.db);
      await migrate(opts.db, {
        migrationsFolder: new URL("./db/drizzle", import.meta.url).pathname,
      });
    },

    registerClog(clog: Clog) {
      registry.register(clog);
    },

    async createRun({ sessionId, clogId, input, initialState, retry }) {
      const runId = randomId("run");
      await createRun(opts.db, {
        runId,
        sessionId,
        clogId,
        initialState,
        input,
        maxAttempts: retry?.maxAttempts,
      });
      return { runId };
    },

    async beginTick({ runId, tickId }) {
      const run = await getRun(opts.db, runId);
      if (!run) throw new Error(`run not found: ${runId}`);

      const id = tickId ?? randomId("tick");
      await beginTickEntity(opts.db, runId, id);
      return { tickId: id };
    },

    async callClog({ runId, tickId, clogId, method, payload }) {
      const run = await getRun(opts.db, runId);
      if (!run) throw new Error(`run not found: ${runId}`);

      const factory = toolInvokerFactoryForTickSync({ runId, tickId, sessionId: run.session_id });
      const tools = factory(clogId);

      const address = `clog.${clogId}.${method}`;
      const result = await tools({ name: "ocean.clog.call", input: { address, payload } });
      if (!result.ok) {
        const err: any = new Error(result.error.message);
        err.code = result.error.code;
        err.details = result.error.details;
        throw err;
      }
      return (result.output as any)?.result;
    },

    async signal(runId, input) {
      await signalRun(opts.db, runId, input);
    },

    async advance() {
      const instanceId = defaultInstanceId;
      const lockMs = opts.lockMs ?? 30_000;
      const results: Array<{ runId: string; outcome: string }> = [];

      const run = await acquireRun(opts.db, instanceId, lockMs);
      if (!run) return { advanced: 0, results: [] };

      // Clear pending_input in the DB now that we've captured it in `run`.
      // This lets applyOutcome detect genuinely new signals that arrive
      // while the handler is executing.
      if (run.pending_input != null) {
        await consumePendingInput(opts.db, run.run_id);
      }

      const handler = registry.getAdvanceHandler(run.clog_id);
      if (!handler) {
        await releaseRun(opts.db, run.run_id, {
          status: "failed",
          last_error: "no onAdvance handler",
        });
        return { advanced: 1, results: [{ runId: run.run_id, outcome: "failed" }] };
      }

      // Create tick
      const tickId = randomId("tick");
      await beginTickEntity(opts.db, run.run_id, tickId);

      // Build tool invoker
      const factory = toolInvokerFactoryForTickSync({
        runId: run.run_id,
        tickId,
        sessionId: run.session_id,
      });
      const tools = factory(run.clog_id);

      // Call onAdvance
      let outcome: TickOutcome;
      try {
        outcome = await handler(run.pending_input, { tools, attempt: run.attempt });
      } catch (e: any) {
        outcome = { status: "retry", error: e?.message ?? String(e) };
      }

      // Apply outcome to run state
      await applyOutcome(opts.db, run, outcome);
      results.push({ runId: run.run_id, outcome: outcome.status });

      return { advanced: 1, results };
    },

    async getRun(runId) {
      const row = await getRun(opts.db, runId);
      if (!row) return null;
      return runRowToInfo(row);
    },

    async readEvents({ scope, afterSeq, limit }) {
      return readEventsByScope(opts.db, scope, afterSeq ?? 0, limit ?? 100);
    },

    async gcEventsIfDue() {
      const ttl = opts.eventsTtlMs;
      if (!ttl) return;

      const minInterval = opts.eventsGcMinIntervalMs ?? 60_000;
      const n = nowMs();
      if (n - lastGcTs < minInterval) return;

      lastGcTs = n;
      await gcEventsByTtl(opts.db, ttl);
    },
  };
}
