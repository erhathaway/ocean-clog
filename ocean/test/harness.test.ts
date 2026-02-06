import { describe, it, expect, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "./harness.js";
import type { Clog, TickOutcome } from "../clogs/types.js";

// ---------------------------------------------------------------------------
// counterClog — test fixture
//
// Tracks a counter via closure (no storage ops needed). Supports commands:
//   "increment" → ok (default)
//   "continue"  → continue with next input
//   "wait"      → wait 60s
//   "fail"      → retry (error string)
//   "done"      → done
// ---------------------------------------------------------------------------

function counterClog(): Clog {
  let counter = 0;

  return {
    id: "counter",
    endpoints: {},
    async onAdvance(input, { tools, attempt }) {
      const action = (typeof input === "string" ? input : (input as any)?.action) ?? "increment";

      counter++;

      // Emit an event so tests can observe
      await tools({
        name: "ocean.events.emit",
        input: {
          scope: { kind: "global" },
          type: "counter.tick",
          payload: { counter, action, attempt },
        },
      });

      switch (action) {
        case "continue":
          return { status: "continue", input: (input as any)?.next ?? "increment" } as TickOutcome;
        case "wait":
          return { status: "wait", wakeAt: Date.now() + 60_000 } as TickOutcome;
        case "fail":
          return { status: "retry", error: "intentional failure" } as TickOutcome;
        case "done":
          return { status: "done" } as TickOutcome;
        default:
          return { status: "ok" } as TickOutcome;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let env: TestEnv;

afterEach(() => {
  env?.destroy();
});

describe("test harness", () => {
  // 1. Basic signal/advance
  it("basic signal and advance", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    const total = await env.cron.drain();
    expect(total).toBe(1);

    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("counter.tick");
    expect((events[0].payload as any).counter).toBe(1);
  });

  // 2. Multi-instance locking
  it("multi-instance locking — only one wins", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const w1 = env.spawnInstance("worker-1");
    const w2 = env.spawnInstance("worker-2");

    await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // Both try to advance — only one should win the lock
    const [r1, r2] = await Promise.all([w1.advance(), w2.advance()]);
    const totalAdvanced = r1.advanced + r2.advanced;
    expect(totalAdvanced).toBe(1);
  });

  // 3. Crash simulation
  it("crash simulation — stopped instance loses lock on expiry", async () => {
    env = await createTestEnv({ clogs: [counterClog], lockMs: 5_000 });

    const w1 = env.spawnInstance("worker-1");
    const w2 = env.spawnInstance("worker-2");

    const { runId } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // w1 processes the first run
    await env.cron.drain();
    let run = await w1.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    // Signal again, then stop w1 before it processes
    await w1.ocean.signal(runId, "increment");
    w1.stop();

    // w2 should pick it up since w1 is stopped
    const total = await env.cron.drain();
    expect(total).toBe(1);

    run = await w2.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
  });

  // 4. Virtual clock + wake_at
  it("virtual clock — run waits and wakes on schedule", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    // Drain — clog should return wait (wakeAt = now + 60s)
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");

    // Advance clock by 30s — not yet time
    env.clock.advance(30_000);
    const partial = await env.cron.drain();
    expect(partial).toBe(0);
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");

    // Advance another 31s — now past wakeAt
    env.clock.advance(31_000);
    // The run should now be picked up (waiting + wake_at <= now)
    // But it will call onAdvance with null input (no pending_input)
    // and onAdvance defaults to "increment" → ok → idle
    const woke = await env.cron.drain();
    expect(woke).toBe(1);
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
  });

  // 5. Retry with backoff
  it("retry with backoff — fails after maxAttempts", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 3 },
    });

    // Attempt 0 → retry → waiting with backoff(1) = 2s
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");
    expect(run?.attempt).toBe(1);

    // Advance past first backoff (2s)
    env.clock.advance(2_500);
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.attempt).toBe(2);

    // Advance past second backoff (4s)
    env.clock.advance(4_500);
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    // attempt 2 → nextAttempt = 3 >= maxAttempts(3) → failed
    expect(run?.status).toBe("failed");
    expect(run?.lastError).toBe("intentional failure");
  });

  // 6. advanceAndDrain
  it("advanceAndDrain — combines clock jump + drain", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    // Process the wait
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");

    // advanceAndDrain jumps clock and drains
    const total = await env.cron.advanceAndDrain(61_000);
    expect(total).toBeGreaterThanOrEqual(1);
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
  });

  // 7. Signal re-triggers idle
  it("signal re-triggers idle run", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    // Signal again
    await env.ocean.signal(runId, "increment");
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    // Should have 2 counter.tick events
    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const counterEvents = events.filter((e) => e.type === "counter.tick");
    expect(counterEvents.length).toBe(2);
    expect((counterEvents[0].payload as any).counter).toBe(1);
    expect((counterEvents[1].payload as any).counter).toBe(2);
  });

  // 8. Continue chains
  it("continue chains — drain processes multiple ticks", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: { action: "continue", next: { action: "continue", next: "increment" } },
    });

    const total = await env.cron.drain();
    // Should process 3 ticks: continue → continue → increment(ok)
    expect(total).toBe(3);

    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const counterEvents = events.filter((e) => e.type === "counter.tick");
    expect(counterEvents.length).toBe(3);
    // Counter incremented 3 times
    expect((counterEvents[2].payload as any).counter).toBe(3);
  });
});
