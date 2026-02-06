import type { SqlClient } from "./db/db.js";
import { enableForeignKeys } from "./db/db.js";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { Clog } from "./clogs/types.js";
import { ClogRegistry } from "./clogs/registry.js";
import { createRun, getRun } from "./engine/run.js";
import { beginTickEntity } from "./engine/tick.js";
import { randomId } from "./core/ids.js";
import { nowMs } from "./core/time.js";
import { gcEventsByTtl, readEventsByScope } from "./engine/events.js";
import type { ReadEventsScope, EventRow } from "./engine/events.js";
import { createToolInvoker } from "./clogs/runtime.js";

export type OceanOptions = {
  db: SqlClient;

  // audit log retention
  eventsTtlMs?: number;
  eventsGcMinIntervalMs?: number;
};

export type Ocean = {
  migrate: () => Promise<void>;
  registerClog: (clog: Clog) => void;

  createRun: (args: { sessionId: string; initialState?: unknown }) => Promise<{ runId: string }>;
  beginTick: (args: { runId: string; tickId?: string }) => Promise<{ tickId: string }>;

  callClog: (args: { runId: string; tickId: string; clogId: string; method: string; payload?: unknown }) => Promise<unknown>;

  readEvents: (args: { scope: ReadEventsScope; afterSeq?: number; limit?: number }) => Promise<EventRow[]>;

  gcEventsIfDue: () => Promise<void>;
};

export function createOcean(opts: OceanOptions): Ocean {
  const registry = new ClogRegistry();
  let lastGcTs = 0;

  async function toolInvokerFactoryForTick(args: {
    runId: string;
    tickId: string;
    sessionId: string;
  }) {
    // returns a factory that creates a fresh per-clog tool invoker (fresh 1R/1W budget)
    return (clogId: string) => {
      const readCalled = { value: false };
      const writeCalled = { value: false };
      const ledger = {
        global: false,
        session: new Set<string>(),
        run: new Set<string>(),
        tickRows: new Set<string>(),
      };

      // placeholder; filled below via closure
      let factory: (id: string) => any;

      const invoker = createToolInvoker({
        db: opts.db,
        registry,
        tickCtx: { clogId, sessionId: args.sessionId, runId: args.runId, tickId: args.tickId },
        readCalled,
        writeCalled,
        ledger,
        toolInvokerFactory: (id: string) => factory(id),
      });

      factory = (id: string) => toolInvokerFactoryForTickSync(args)(id);

      // The above self-reference is tricky; use the sync helper below.
      return invoker;
    };
  }

  function toolInvokerFactoryForTickSync(args: { runId: string; tickId: string; sessionId: string }) {
    return (clogId: string) => {
      const readCalled = { value: false };
      const writeCalled = { value: false };
      const ledger = {
        global: false,
        session: new Set<string>(),
        run: new Set<string>(),
        tickRows: new Set<string>(),
      };

      const factory = toolInvokerFactoryForTickSync(args);

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

    async createRun({ sessionId, initialState }) {
      const runId = randomId("run");
      await createRun(opts.db, runId, sessionId, initialState ?? { created: nowMs() });
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
