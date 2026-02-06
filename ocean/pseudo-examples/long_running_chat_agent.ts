/**
 * Long-running chat agent — background execution via signal/advance
 *
 * Scenario: A conversational AI agent that lives inside a serverless function.
 * Each user message is a signal. The worker picks it up, calls an LLM, streams
 * deltas back, persists the conversation, and idles until the next message.
 *
 * The run stays alive across many request/response cycles. The serverless
 * function is stateless — all state lives in Ocean's SQLite database.
 *
 * Flow:
 *   1. Client POST /chat  →  signal(runId, { text })  →  202 Accepted
 *   2. Worker loop calls   advance()  →  onAdvance fires  →  LLM streams
 *   3. Client GET /events  →  readEvents({ scope: { kind: "run", runId } })
 *   4. Repeat forever (run never "done" — it idles between messages)
 */

import type { Clog, TickOutcome } from "../clogs/types.js";
import type { Ocean } from "../ocean.js";

// ---------------------------------------------------------------------------
// 1. The clog — defines onAdvance (the "tick" handler)
// ---------------------------------------------------------------------------

export const chatAgentClog: Clog = {
  id: "chat_agent",

  async onAdvance(input, { tools, attempt }): Promise<TickOutcome> {
    const { text } = (input ?? {}) as { text?: string };
    if (!text) return { status: "ok" }; // spurious wake — go back to idle

    // Read conversation history from run storage
    const read = await tools({
      name: "ocean.storage.read_scoped",
      input: { plans: [{ kind: "run" }] },
    });
    if (!read.ok) return { status: "retry", error: read.error.message };

    const state = ((read.output as any).snapshot?.[0]?.value ?? { messages: [] }) as {
      messages: Array<{ role: string; content: string }>;
    };

    // Append user message
    state.messages.push({ role: "user", content: text });

    // --- Call your LLM here (pseudo) ---
    // const stream = await llm.chat(state.messages);
    // for await (const chunk of stream) {
    //   await tools({ name: "ocean.events.emit", input: {
    //     scope: { kind: "run" }, type: "run.delta", payload: { text: chunk },
    //   }});
    // }
    const assistantReply = `[LLM response to: ${text}]`;

    // Emit the final message as an event (clients poll this)
    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "run" },
        type: "run.message",
        payload: { role: "assistant", content: assistantReply },
      },
    });

    // Append assistant message and persist
    state.messages.push({ role: "assistant", content: assistantReply });
    const write = await tools({
      name: "ocean.storage.write_scoped",
      input: { ops: [{ op: "run.set", value: state }] },
    });
    if (!write.ok) return { status: "retry", error: write.error.message };

    // Return "ok" — run goes back to idle, waiting for the next signal
    return { status: "ok" };
  },

  endpoints: {},
};

// ---------------------------------------------------------------------------
// 2. Serverless function (pseudo code)
// ---------------------------------------------------------------------------

/*
 * Imagine this running on Cloudflare Workers, Vercel Edge, AWS Lambda, etc.
 * Ocean is initialized once per cold start. The DB is a Turso/libSQL remote.
 *
 *   import { createOcean, createLibsqlDb } from "ocean";
 *   import { chatAgentClog } from "./long_running_chat_agent.js";
 *
 *   const db = createLibsqlDb({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
 *   const ocean = createOcean({ db });
 *   ocean.registerClog(chatAgentClog);
 *   await ocean.migrate();
 *
 *   // ---- Routes ----
 *
 *   POST /sessions/:sessionId/runs
 *     // Create a new long-lived chat run
 *     const { runId } = await ocean.createRun({
 *       sessionId: params.sessionId,
 *       clogId: "chat_agent",
 *     });
 *     return json({ runId }, 201);
 *
 *
 *   POST /runs/:runId/messages
 *     // User sends a message — signal the run, then drain the queue
 *     const { text } = await req.json();
 *     await ocean.signal(params.runId, { text });
 *
 *     // Process immediately in this request (or let a cron do it)
 *     await ocean.advance();
 *
 *     return json({ ok: true }, 202);
 *
 *
 *   GET /runs/:runId/events?after=0
 *     // Client polls for new events (SSE or long-poll works too)
 *     const events = await ocean.readEvents({
 *       scope: { kind: "run", runId: params.runId },
 *       afterSeq: Number(query.after) || 0,
 *     });
 *     return json({ events });
 *
 *
 *   GET /runs/:runId
 *     // Inspect run status (idle, pending, failed, etc.)
 *     const info = await ocean.getRun(params.runId);
 *     return json(info);
 *
 *
 *   // ---- Worker loop (cron trigger or Durable Object alarm) ----
 *   //
 *   // If you don't want to advance() inline in the POST handler,
 *   // run a cron that calls advance() in a loop:
 *   //
 *   //   scheduled(event, env, ctx) {
 *   //     let budget = 25_000; // ms
 *   //     while (budget > 0) {
 *   //       const start = Date.now();
 *   //       const result = await ocean.advance();
 *   //       if (result.advanced === 0) break; // nothing to do
 *   //       budget -= (Date.now() - start);
 *   //     }
 *   //   }
 */

// ---------------------------------------------------------------------------
// 3. State machine walkthrough
// ---------------------------------------------------------------------------

/*
 * Lifecycle of a single chat run:
 *
 *   createRun(clogId: "chat_agent")
 *     → status: "idle"
 *
 *   signal(runId, { text: "hello" })
 *     → status: "pending", pending_input: { text: "hello" }
 *
 *   advance()
 *     → acquires lock
 *     → calls onAdvance({ text: "hello" }, { tools, attempt: 0 })
 *     → onAdvance reads history, calls LLM, emits events, writes state
 *     → returns { status: "ok" }
 *     → status: "idle", pending_input: null
 *
 *   signal(runId, { text: "tell me more" })
 *     → status: "pending", pending_input: { text: "tell me more" }
 *
 *   advance()
 *     → ... same cycle ...
 *     → status: "idle"
 *
 *   // If the LLM call throws:
 *   advance()
 *     → onAdvance throws Error("rate limited")
 *     → caught → { status: "retry", error: "rate limited" }
 *     → attempt: 1, status: "pending", wake_at: now + 2s (exponential backoff)
 *     → next advance() after wake_at retries automatically
 *     → after max_attempts (default 3) → status: "failed"
 *
 *   // Race condition: user signals while onAdvance is running:
 *   advance()  ← processing { text: "hello" }
 *   signal(runId, { text: "wait actually..." })  ← writes pending_input
 *   advance() finishes → returns { status: "ok" }
 *     → applyOutcome checks for new pending_input
 *     → status: "pending" (not "idle") — will be picked up by next advance()
 */
