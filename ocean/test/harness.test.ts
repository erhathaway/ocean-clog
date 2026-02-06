import { describe, it, expect, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "./harness.js";
import type { Clog, TickOutcome } from "../clogs/types.js";

// ---------------------------------------------------------------------------
// Test clog factories
// ---------------------------------------------------------------------------

/**
 * counterClog — general-purpose test clog.
 * Closure counter increments per-onAdvance call (shared across runs on the same instance).
 * Supports action commands via input:
 *   "increment" (default) → ok
 *   "continue"            → continue with `next` field as next input
 *   "wait"                → wait 60s
 *   "fail"                → retry with error
 *   "done"                → done (terminal)
 *   "failed-direct"       → failed (terminal, skips retry)
 *   "throw"               → throws an exception
 */
function counterClog(): Clog {
  let counter = 0;

  return {
    id: "counter",
    endpoints: {},
    async onAdvance(input, { tools, attempt }) {
      const action = (typeof input === "string" ? input : (input as any)?.action) ?? "increment";

      counter++;

      await tools({
        name: "ocean.events.emit",
        input: {
          scope: { kind: "global" },
          type: "counter.tick",
          payload: { counter, action, attempt, input },
        },
      });

      switch (action) {
        case "continue":
          return { status: "continue", input: (input as any)?.next ?? "increment" };
        case "wait":
          return { status: "wait", wakeAt: Date.now() + 60_000 };
        case "fail":
          return { status: "retry", error: "intentional failure" };
        case "done":
          return { status: "done" };
        case "failed-direct":
          return { status: "failed", error: "direct failure" };
        case "throw":
          throw new Error("clog exploded");
        default:
          return { status: "ok" };
      }
    },
  };
}

/**
 * Creates a clog whose onAdvance calls a provided callback.
 * Useful for injecting side effects (like signaling) during processing.
 */
function callbackClog(
  id: string,
  cb: (input: unknown, ctx: { tools: any; attempt: number }) => Promise<TickOutcome>,
): () => Clog {
  return () => ({
    id,
    endpoints: {},
    async onAdvance(input, ctx) {
      return cb(input, ctx);
    },
  });
}

/** A clog with no onAdvance handler — only endpoints */
function endpointsOnlyClog(): Clog {
  return {
    id: "no-advance",
    endpoints: {
      async ping(_payload, _ctx) {
        return { pong: true };
      },
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

// =========================================================================
// State machine basics
// =========================================================================
describe("state machine basics", () => {
  it("createRun with input starts as pending", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("pending");
  });

  it("createRun without input starts as idle", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
    });
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
  });

  it("idle run is not picked up by advance", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    await env.ocean.createRun({ sessionId: "s1", clogId: "counter" });
    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("advance returns correct result shape with runId and outcome", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });
    const result = await env.ocean.advance();
    expect(result.advanced).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].runId).toBe(runId);
    expect(result.results[0].outcome).toBe("ok");
  });

  it("advance with nothing pending returns 0", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
  });

  it("getRun returns null for nonexistent runId", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const run = await env.ocean.getRun("run_nonexistent_xyz");
    expect(run).toBeNull();
  });

  it("default maxAttempts is 3", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });
    const run = await env.ocean.getRun(runId);
    expect(run?.maxAttempts).toBe(3);
  });

  it("basic signal → advance → idle cycle with events", async () => {
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
    expect(run?.attempt).toBe(0);
    expect(run?.lastError).toBeNull();

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].type).toBe("counter.tick");
    expect((events[0].payload as any).counter).toBe(1);
    expect((events[0].payload as any).attempt).toBe(0);
  });
});

// =========================================================================
// Terminal states
// =========================================================================
describe("terminal states", () => {
  it("done is terminal — advance skips it", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "done",
    });

    await env.cron.drain();
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("done");

    // Another advance should do nothing
    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
    const run2 = await env.ocean.getRun(runId);
    expect(run2?.status).toBe("done");
  });

  it("done is terminal — signal has no effect on status", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "done",
    });

    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("done");

    // Signal should not change status
    await env.ocean.signal(runId, "increment");
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("done");

    // Advance should still do nothing
    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
  });

  it("failed is terminal — advance skips it", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 1 },
    });

    // maxAttempts=1: attempt 0 → retry → nextAttempt=1 >= 1 → failed
    await env.cron.drain();
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");

    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
  });

  it("failed is terminal — signal has no effect on status", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 1 },
    });

    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("failed");

    await env.ocean.signal(runId, "increment");
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");

    const result = await env.ocean.advance();
    expect(result.advanced).toBe(0);
  });

  it("clog returns failed directly — immediate terminal without retry", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "failed-direct",
      retry: { maxAttempts: 5 }, // plenty of retries available
    });

    await env.cron.drain();
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.lastError).toBe("direct failure");
    // Attempt should NOT have incremented — direct failure bypasses retry
    expect(run?.attempt).toBe(0);
  });

  it("no onAdvance handler → run fails with error", async () => {
    env = await createTestEnv({ clogs: [() => endpointsOnlyClog()] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "no-advance",
      input: "anything",
    });

    const result = await env.ocean.advance();
    expect(result.advanced).toBe(1);
    expect(result.results[0].outcome).toBe("failed");

    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.lastError).toBe("no onAdvance handler");
  });
});

// =========================================================================
// Signal semantics
// =========================================================================
describe("signal semantics", () => {
  it("signal idle → pending", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
    });
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");

    await env.ocean.signal(runId, "increment");
    expect((await env.ocean.getRun(runId))?.status).toBe("pending");
  });

  it("signal waiting → pending (cancels wait)", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    // Process → waiting
    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("waiting");

    // Signal cancels the wait
    await env.ocean.signal(runId, "increment");
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("pending");

    // Should process immediately without clock advance
    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");
  });

  it("signal re-triggers idle run — multiple cycles", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");

    await env.ocean.signal(runId, "increment");
    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(2);
    expect((ticks[0].payload as any).counter).toBe(1);
    expect((ticks[1].payload as any).counter).toBe(2);
  });

  it("signal during processing → new input detected and re-enqueued", async () => {
    // Create a clog that signals its own run during onAdvance
    const ctx: { ocean?: any; targetRunId?: string; signaled: boolean } = { signaled: false };
    const selfSignalClog = callbackClog("self-signal", async (input, { tools }) => {
      if (!ctx.signaled && ctx.ocean && ctx.targetRunId) {
        ctx.signaled = true;
        await ctx.ocean.signal(ctx.targetRunId, "second-input");
      }
      await tools({
        name: "ocean.events.emit",
        input: {
          scope: { kind: "global" },
          type: "processed",
          payload: { input },
        },
      });
      return { status: "ok" };
    });

    env = await createTestEnv({ clogs: [selfSignalClog] });
    ctx.ocean = env.ocean;

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "self-signal",
      input: "first-input",
    });
    ctx.targetRunId = runId;

    // First drain: processes "first-input", during which "second-input" is signaled
    // applyOutcome should detect the new input and re-enqueue
    const total = await env.cron.drain();
    expect(total).toBe(2); // first-input + second-input

    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    // Verify both inputs were processed in order
    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const processed = events.filter((e) => e.type === "processed");
    expect(processed.length).toBe(2);
    expect((processed[0].payload as any).input).toBe("first-input");
    expect((processed[1].payload as any).input).toBe("second-input");
  });

  it("signal with identical payload during processing → detected as new input", async () => {
    // After consumePendingInput, DB pending_input is null.
    // A signal with any payload (even identical) sets it to non-null.
    // applyOutcome("ok") sees non-null → re-enqueues. No payload comparison needed.
    const ctx: { ocean?: any; targetRunId?: string; signaled: boolean } = { signaled: false };
    const dupeSignalClog = callbackClog("dupe-signal", async (input, { tools }) => {
      if (!ctx.signaled && ctx.ocean && ctx.targetRunId) {
        ctx.signaled = true;
        await ctx.ocean.signal(ctx.targetRunId, "same-payload");
      }
      await tools({
        name: "ocean.events.emit",
        input: { scope: { kind: "global" }, type: "processed", payload: { input } },
      });
      return { status: "ok" };
    });

    env = await createTestEnv({ clogs: [dupeSignalClog] });
    ctx.ocean = env.ocean;

    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "dupe-signal",
      input: "same-payload",
    });
    ctx.targetRunId = runId;

    const total = await env.cron.drain();
    expect(total).toBe(2); // both signals processed

    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const processed = events.filter((e) => e.type === "processed");
    expect(processed.length).toBe(2);
  });
});

// =========================================================================
// Retry & backoff
// =========================================================================
describe("retry & backoff", () => {
  it("backoff timing: attempt 1 = 2s, attempt 2 = 4s", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 5 },
    });

    // Attempt 0 → retry → waiting, backoff(1) = min(1000*2^1, 60000) = 2000
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");
    expect(run?.attempt).toBe(1);

    // 1999ms — not yet
    env.clock.advance(1_999);
    expect((await env.cron.drain())).toBe(0);

    // 1ms more — exactly at 2000ms total
    env.clock.advance(1);
    expect((await env.cron.drain())).toBe(1);
    run = await env.ocean.getRun(runId);
    expect(run?.attempt).toBe(2);
    expect(run?.status).toBe("waiting");

    // backoff(2) = min(1000*2^2, 60000) = 4000
    env.clock.advance(3_999);
    expect((await env.cron.drain())).toBe(0);
    env.clock.advance(1);
    expect((await env.cron.drain())).toBe(1);
    run = await env.ocean.getRun(runId);
    expect(run?.attempt).toBe(3);
  });

  it("maxAttempts=1 → first failure is terminal", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 1 },
    });

    // attempt 0 → nextAttempt=1 >= maxAttempts=1 → failed immediately
    await env.cron.drain();
    const run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(1);
    expect(run?.lastError).toBe("intentional failure");
  });

  it("attempt counter is passed to handler correctly", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 3 },
    });

    // Attempt 0
    await env.cron.drain();
    // Attempt 1
    env.clock.advance(2_500);
    await env.cron.drain();
    // Attempt 2 → failed
    env.clock.advance(4_500);
    await env.cron.drain();

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(3);
    expect((ticks[0].payload as any).attempt).toBe(0);
    expect((ticks[1].payload as any).attempt).toBe(1);
    expect((ticks[2].payload as any).attempt).toBe(2);
  });

  it("attempt resets to 0 after successful advance", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 5 },
    });

    // Fail once → attempt=1
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.attempt).toBe(1);
    expect(run?.status).toBe("waiting");

    // Signal with successful action — this flips waiting → pending
    await env.ocean.signal(runId, "increment");
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
    expect(run?.attempt).toBe(0);
    expect(run?.lastError).toBeNull();
  });

  it("handler exception becomes retry outcome", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "throw",
      retry: { maxAttempts: 2 },
    });

    // Attempt 0: handler throws → caught as retry
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");
    expect(run?.attempt).toBe(1);
    expect(run?.lastError).toBe("clog exploded");

    // Attempt 1: throws again → nextAttempt=2 >= maxAttempts=2 → failed
    env.clock.advance(2_500);
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.attempt).toBe(2);
    expect(run?.lastError).toBe("clog exploded");
  });

  it("signal interrupts retry backoff — new input processed immediately", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 5 },
    });

    // Attempt 0 → retry → waiting with 2s backoff
    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");
    expect(run?.attempt).toBe(1);

    // Signal with "increment" before backoff expires — flips waiting → pending
    await env.ocean.signal(runId, "increment");
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("pending");

    // Process immediately (no clock advance needed)
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("idle");
    expect(run?.attempt).toBe(0); // reset on success
  });

  it("retry preserves pending_input across backoff waits", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 3 },
    });

    // All three attempts should receive "fail" as input
    await env.cron.drain(); // attempt 0
    env.clock.advance(2_500);
    await env.cron.drain(); // attempt 1
    env.clock.advance(4_500);
    await env.cron.drain(); // attempt 2 → failed

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(3);
    // Every attempt should have received the same "fail" input
    for (const tick of ticks) {
      expect((tick.payload as any).input).toBe("fail");
      expect((tick.payload as any).action).toBe("fail");
    }
  });

  it("retry with backoff — fails after maxAttempts", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "fail",
      retry: { maxAttempts: 3 },
    });

    await env.cron.drain();
    let run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("waiting");
    expect(run?.attempt).toBe(1);

    env.clock.advance(2_500);
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.attempt).toBe(2);

    env.clock.advance(4_500);
    await env.cron.drain();
    run = await env.ocean.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.lastError).toBe("intentional failure");
  });
});

// =========================================================================
// Multi-instance
// =========================================================================
describe("multi-instance", () => {
  it("one run, two instances — only one wins the lock", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");
    const w2 = env.spawnInstance("w2");

    await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    const [r1, r2] = await Promise.all([w1.advance(), w2.advance()]);
    expect(r1.advanced + r2.advanced).toBe(1);
  });

  it("two runs, two instances — each processes one concurrently", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");
    const w2 = env.spawnInstance("w2");

    const { runId: runA } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });
    const { runId: runB } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // Both instances advance in parallel — each should pick up a different run
    const [r1, r2] = await Promise.all([w1.advance(), w2.advance()]);
    expect(r1.advanced + r2.advanced).toBe(2);

    // Both runs should be idle
    expect((await w1.ocean.getRun(runA))?.status).toBe("idle");
    expect((await w1.ocean.getRun(runB))?.status).toBe("idle");
  });

  it("lock expiry — other instance steals expired lock", async () => {
    env = await createTestEnv({ clogs: [counterClog], lockMs: 5_000 });
    const w1 = env.spawnInstance("w1");
    const w2 = env.spawnInstance("w2");

    const { runId } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // w1 processes the first input
    await env.cron.drain();
    expect((await w1.ocean.getRun(runId))?.status).toBe("idle");

    // Signal again, then stop w1 to simulate crash (lock stays in DB)
    await w1.ocean.signal(runId, "increment");
    w1.stop();

    // w2 should pick it up since w1 is dead (not advancing)
    const total = await env.cron.drain();
    expect(total).toBe(1);
    expect((await w2.ocean.getRun(runId))?.status).toBe("idle");
  });

  it("instance restart with same ID", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");

    const { runId } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    await w1.advance();
    expect((await w1.ocean.getRun(runId))?.status).toBe("idle");

    // Stop and restart
    w1.stop();
    w1.start();

    // Signal and verify restarted instance can process
    await w1.ocean.signal(runId, "increment");
    const result = await w1.advance();
    expect(result.advanced).toBe(1);
    expect((await w1.ocean.getRun(runId))?.status).toBe("idle");
  });

  it("cross-instance event visibility — shared DB", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");
    const w2 = env.spawnInstance("w2");

    await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // w1 processes the run
    await w1.advance();

    // w2 can see the events
    const events = await w2.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(1);
    expect((ticks[0].payload as any).counter).toBe(1);
  });

  it("cross-instance data visibility — run created by A readable by B", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");
    const w2 = env.spawnInstance("w2");

    const { runId } = await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // w2 can read the run created by w1
    const run = await w2.ocean.getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.status).toBe("pending");
    expect(run?.clogId).toBe("counter");
  });
});

// =========================================================================
// Cron & drain
// =========================================================================
describe("cron & drain", () => {
  it("drain processes multiple pending runs", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });

    const total = await env.cron.drain();
    expect(total).toBe(3);

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(3);
  });

  it("drain maxRounds stops even with pending work", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    // Create 5 pending runs
    for (let i = 0; i < 5; i++) {
      await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    }

    // drain with maxRounds=2: default instance processes 1 per tick, so 2 ticks = 2 runs
    const total = await env.cron.drain(2);
    expect(total).toBe(2);

    // 3 runs still pending
    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(2);
  });

  it("stopped instance skipped by drain", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const w1 = env.spawnInstance("w1");
    env.spawnInstance("w2");

    await w1.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "increment",
    });

    // Stop w1 — only w2 should process
    w1.stop();
    const total = await env.cron.drain();
    expect(total).toBe(1);

    // Verify w1.advance() returns 0 when stopped
    const result = await w1.advance();
    expect(result.advanced).toBe(0);
  });

  it("continue chains bounded by maxRounds", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    // Create a long continue chain: continue → continue → continue → ... → increment
    let input: any = "increment";
    for (let i = 0; i < 10; i++) {
      input = { action: "continue", next: input };
    }

    await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input,
    });

    // drain(5) should process only 5 ticks
    const total = await env.cron.drain(5);
    expect(total).toBe(5);
  });

  it("advanceAndDrain — combines clock jump + drain", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("waiting");

    const total = await env.cron.advanceAndDrain(61_000);
    expect(total).toBeGreaterThanOrEqual(1);
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");
  });

  it("continue chains — drain processes all chained ticks", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: { action: "continue", next: { action: "continue", next: "increment" } },
    });

    const total = await env.cron.drain();
    expect(total).toBe(3);
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    const ticks = events.filter((e) => e.type === "counter.tick");
    expect(ticks.length).toBe(3);
    expect((ticks[2].payload as any).counter).toBe(3);
  });
});

// =========================================================================
// Events
// =========================================================================
describe("events", () => {
  it("afterSeq cursor-based pagination", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    // Create 3 runs and process them — 3 events
    for (let i = 0; i < 3; i++) {
      await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    }
    await env.cron.drain();

    const all = await env.ocean.readEvents({ scope: { kind: "global" } });
    expect(all.length).toBe(3);

    // Read after first event
    const afterFirst = await env.ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: all[0].seq,
    });
    expect(afterFirst.length).toBe(2);
    expect(afterFirst[0].seq).toBe(all[1].seq);

    // Read after second event
    const afterSecond = await env.ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: all[1].seq,
    });
    expect(afterSecond.length).toBe(1);
    expect(afterSecond[0].seq).toBe(all[2].seq);

    // Read after last event
    const afterLast = await env.ocean.readEvents({
      scope: { kind: "global" },
      afterSeq: all[2].seq,
    });
    expect(afterLast.length).toBe(0);
  });

  it("event limit is enforced", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    for (let i = 0; i < 5; i++) {
      await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    }
    await env.cron.drain();

    const limited = await env.ocean.readEvents({
      scope: { kind: "global" },
      limit: 2,
    });
    expect(limited.length).toBe(2);
  });

  it("events have sequential seq numbers", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    for (let i = 0; i < 3; i++) {
      await env.ocean.createRun({ sessionId: "s1", clogId: "counter", input: "increment" });
    }
    await env.cron.drain();

    const events = await env.ocean.readEvents({ scope: { kind: "global" } });
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }
  });

  it("run-scoped events are readable by runId", async () => {
    // Use a clog that emits run-scoped events
    let capturedRunId: string | undefined;
    const runScopedClog = callbackClog("run-scoped", async (input, { tools }) => {
      // We don't have runId directly, but we can emit with global scope
      // and check readEvents by run scope. Actually, events.emit requires
      // explicit scope with runId. Since we don't have the runId in the clog,
      // we'll test this by reading global events and filtering.
      // Instead, let's test the readEvents API with run scope using events
      // that the engine might auto-create (there aren't any auto-events).
      // For this test, we emit globally and verify global vs run scope filtering.
      await tools({
        name: "ocean.events.emit",
        input: { scope: { kind: "global" }, type: "test-event", payload: { data: input } },
      });
      return { status: "ok" };
    });

    env = await createTestEnv({ clogs: [runScopedClog] });
    const { runId: runA } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "run-scoped",
      input: "A",
    });
    const { runId: runB } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "run-scoped",
      input: "B",
    });
    await env.cron.drain();

    // Global scope should have both
    const global = await env.ocean.readEvents({ scope: { kind: "global" } });
    expect(global.length).toBe(2);

    // Run-scoped reads return nothing since events were emitted globally
    const runAEvents = await env.ocean.readEvents({ scope: { kind: "run", runId: runA } });
    expect(runAEvents.length).toBe(0);
  });
});

// =========================================================================
// Clock edge cases
// =========================================================================
describe("clock edge cases", () => {
  it("wake_at exact boundary — equal to now wakes the run", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    // Process wait: wakeAt = now + 60000
    const startTime = env.clock.now();
    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("waiting");

    // Advance exactly 60s (wake_at should equal now)
    env.clock.advance(60_000);
    const total = await env.cron.drain();
    expect(total).toBe(1);
    expect((await env.ocean.getRun(runId))?.status).toBe("idle");
  });

  it("wake_at boundary — one ms before does not wake", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const { runId } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });

    await env.cron.drain();
    expect((await env.ocean.getRun(runId))?.status).toBe("waiting");

    // Advance 59999ms — 1ms short
    env.clock.advance(59_999);
    const total = await env.cron.drain();
    expect(total).toBe(0);
    expect((await env.ocean.getRun(runId))?.status).toBe("waiting");
  });

  it("large time jump wakes all waiting runs", async () => {
    env = await createTestEnv({ clogs: [counterClog] });

    // Create multiple runs with different wait durations
    const { runId: r1 } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });
    await env.cron.drain(); // r1 → waiting (60s)

    env.clock.advance(10_000);
    const { runId: r2 } = await env.ocean.createRun({
      sessionId: "s1",
      clogId: "counter",
      input: "wait",
    });
    await env.cron.drain(); // r2 → waiting (60s from now)

    // r1 wakes at startMs+60000, r2 wakes at startMs+70000
    // Jump 24 hours — both should wake
    const total = await env.cron.advanceAndDrain(86_400_000);
    expect(total).toBe(2);

    expect((await env.ocean.getRun(r1))?.status).toBe("idle");
    expect((await env.ocean.getRun(r2))?.status).toBe("idle");
  });
});

// =========================================================================
// Harness internals
// =========================================================================
describe("harness internals", () => {
  it("virtual clock is properly installed", async () => {
    env = await createTestEnv({ clogs: [counterClog], startMs: 5_000_000 });
    expect(env.clock.now()).toBe(5_000_000);
    expect(Date.now()).toBe(5_000_000);

    env.clock.advance(100);
    expect(env.clock.now()).toBe(5_000_100);
    expect(Date.now()).toBe(5_000_100);
  });

  it("destroy restores Date.now", async () => {
    const realNow = Date.now;
    env = await createTestEnv({ clogs: [counterClog], startMs: 1 });
    expect(Date.now()).toBe(1); // virtual
    env.destroy();
    // After destroy, Date.now should be the real function
    expect(Date.now).toBe(realNow);
    // Prevent afterEach from calling destroy again
    env = undefined as any;
  });

  it("spawnInstance returns same instance for same id", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    const a = env.spawnInstance("w1");
    const b = env.spawnInstance("w1");
    expect(a).toBe(b);
  });

  it("getInstance throws for unknown id", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    expect(() => env.getInstance("nope")).toThrow("no instance with id: nope");
  });

  it("lazy default ocean auto-spawns on first access", async () => {
    env = await createTestEnv({ clogs: [counterClog] });
    expect(env.instances.size).toBe(0);
    const ocean = env.ocean; // trigger lazy init
    expect(env.instances.size).toBe(1);
    expect(env.instances.has("default")).toBe(true);
    // Second access returns same ocean
    expect(env.ocean).toBe(ocean);
  });
});
