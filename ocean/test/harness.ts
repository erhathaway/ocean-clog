import { createOcean } from "../ocean.js";
import type { Ocean } from "../ocean.js";
import type { Clog } from "../clogs/types.js";
import { createLibsqlDb } from "../db/libsql.js";
import type { SqlClient } from "../db/db.js";
import { _setTestClock } from "../core/time.js";

// ---------------------------------------------------------------------------
// TestClock
// ---------------------------------------------------------------------------

export type TestClock = {
  now(): number;
  set(ms: number): void;
  advance(deltaMs: number): void;
};

function createTestClock(startMs: number): TestClock {
  let _now = startMs;
  return {
    now: () => _now,
    set: (ms: number) => { _now = ms; },
    advance: (deltaMs: number) => { _now += deltaMs; },
  };
}

// ---------------------------------------------------------------------------
// TestInstance
// ---------------------------------------------------------------------------

export type TestInstance = {
  instanceId: string;
  alive: boolean;
  ocean: Ocean;
  advance(): Promise<{ advanced: number; results: Array<{ runId: string; outcome: string }> }>;
  stop(): void;
  start(): void;
};

type InstanceInternals = {
  db: SqlClient;
  instanceId: string;
  alive: boolean;
  ocean: Ocean;
  clogFactories: Array<() => Clog>;
  lockMs: number;
};

function createTestInstance(
  db: SqlClient,
  instanceId: string,
  clogFactories: Array<() => Clog>,
  lockMs: number,
): TestInstance {
  const internals: InstanceInternals = {
    db,
    instanceId,
    alive: true,
    ocean: buildOcean(db, instanceId, clogFactories, lockMs),
    clogFactories,
    lockMs,
  };

  return {
    get instanceId() { return internals.instanceId; },
    get alive() { return internals.alive; },
    get ocean() { return internals.ocean; },

    async advance() {
      if (!internals.alive) return { advanced: 0, results: [] };
      return internals.ocean.advance();
    },

    stop() {
      internals.alive = false;
    },

    start() {
      internals.alive = true;
      internals.ocean = buildOcean(db, instanceId, clogFactories, lockMs);
    },
  };
}

function buildOcean(
  db: SqlClient,
  instanceId: string,
  clogFactories: Array<() => Clog>,
  lockMs: number,
): Ocean {
  const ocean = createOcean({ db, instanceId, lockMs });
  for (const factory of clogFactories) {
    ocean.registerClog(factory());
  }
  return ocean;
}

// ---------------------------------------------------------------------------
// TestCron
// ---------------------------------------------------------------------------

export type TestCron = {
  tick(): Promise<number>;
  drain(maxRounds?: number): Promise<number>;
  advanceAndDrain(deltaMs: number, maxRounds?: number): Promise<number>;
};

function createTestCron(
  instances: Map<string, TestInstance>,
  clock: TestClock,
): TestCron {
  async function tick(): Promise<number> {
    let total = 0;
    for (const inst of instances.values()) {
      if (!inst.alive) continue;
      const r = await inst.advance();
      total += r.advanced;
    }
    return total;
  }

  async function drain(maxRounds = 100): Promise<number> {
    let totalAdvanced = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await tick();
      totalAdvanced += n;
      if (n === 0) break;
    }
    return totalAdvanced;
  }

  async function advanceAndDrain(deltaMs: number, maxRounds = 100): Promise<number> {
    clock.advance(deltaMs);
    return drain(maxRounds);
  }

  return { tick, drain, advanceAndDrain };
}

// ---------------------------------------------------------------------------
// TestEnv
// ---------------------------------------------------------------------------

export type TestEnv = {
  db: SqlClient;
  clock: TestClock;
  cron: TestCron;
  instances: Map<string, TestInstance>;
  spawnInstance(id?: string): TestInstance;
  getInstance(id: string): TestInstance;
  /** Lazy default instance — auto-spawned on first access */
  readonly ocean: Ocean;
  destroy(): void;
};

export type CreateTestEnvOptions = {
  clogs: Array<() => Clog>;
  lockMs?: number;
  startMs?: number;
};

export async function createTestEnv(opts: CreateTestEnvOptions): Promise<TestEnv> {
  const startMs = opts.startMs ?? 1_000_000_000_000;
  const lockMs = opts.lockMs ?? 30_000;
  const clogFactories = opts.clogs;

  // 1. Virtual clock
  const clock = createTestClock(startMs);

  // 2. Install clock hooks
  _setTestClock(() => clock.now());
  const origDateNow = Date.now;
  Date.now = () => clock.now();

  // 3. In-memory DB
  const { db } = createLibsqlDb({ url: ":memory:" });

  // 4. Run migrations via a temporary Ocean instance
  const migrator = createOcean({ db });
  await migrator.migrate();

  // 5. Instance map + cron
  const instances = new Map<string, TestInstance>();
  const cron = createTestCron(instances, clock);

  let _defaultInstance: TestInstance | null = null;

  function spawnInstance(id?: string): TestInstance {
    const instanceId = id ?? `inst_${instances.size}`;
    if (instances.has(instanceId)) {
      return instances.get(instanceId)!;
    }
    const inst = createTestInstance(db, instanceId, clogFactories, lockMs);
    instances.set(instanceId, inst);
    return inst;
  }

  function getInstance(id: string): TestInstance {
    const inst = instances.get(id);
    if (!inst) throw new Error(`no instance with id: ${id}`);
    return inst;
  }

  function getDefaultOcean(): Ocean {
    if (!_defaultInstance) {
      _defaultInstance = spawnInstance("default");
    }
    return _defaultInstance.ocean;
  }

  function destroy() {
    _setTestClock(null);
    Date.now = origDateNow;
  }

  return {
    db,
    clock,
    cron,
    instances,
    spawnInstance,
    getInstance,
    get ocean() { return getDefaultOcean(); },
    destroy,
  };
}
