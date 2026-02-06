# Ocean Clog  🌊 👞

## **Your own personal AI assistant** with **one click deploy** on **serverless compute**.


Ocean Clog is a persistence-first system for building resumable AI agents. **Ocean** is the runtime — it handles durable state, bounded execution, and streaming. **Clogs** are the adapters — modular pieces that plug into Ocean to do the actual work (chat, search, browsing, planning, memory, billing, whatever you need).

Think of it like a kernel and its drivers. Ocean is the kernel. Clogs are the drivers.

## Why this exists

Most agent frameworks assume you have a long-running server. That's fine until:

- Your serverless function times out mid-conversation
- Your process crashes and the agent forgets everything
- You want to deploy to Vercel/Netlify/Cloudflare and realize nothing persists
- You're debugging a failure and have no idea what the agent actually did

Ocean Clog starts from a different premise: **everything is durable by default**. State is in the database. Progress happens in bounded ticks. The audit log captures every event. If your process dies, pick up exactly where you left off.

No Redis. No message queues. No background workers. One database and your clogs running on Ocean.

## How it works

```
Request comes in
  -> Ocean creates a tick (bounded unit of work)
    -> Your clog runs inside the tick
      -> Reads state (storage tools)
      -> Does work (LLM calls, other clogs, whatever)
      -> Emits events (streaming deltas, telemetry)
      -> Writes state (storage tools)
  -> Response goes out
```

That's the whole execution model.

### Ocean (the runtime)

> see [./ocean/README.md](./ocean) for details


Ocean provides the execution substrate:

**Runs** — A durable state machine owned by a clog. One per conversation, workflow, or task. Runs persist across requests and survive process crashes.

**Ticks** — A bounded unit of progress inside a run. One per user message, one per webhook, one per cron hit. Work happens in ticks.

**Signal / Advance** — The primary execution pattern. `signal(runId, input)` queues work. `advance()` picks up one ready run, locks it, calls the owning clog's `onAdvance` handler, and applies the outcome. No background workers — call `advance()` from any request or cron.

**Events** — An append-only audit log. Every streaming delta, every tool call, every state change. Perfect for SSE, polling, debugging, and replays.

**Storage** — Four scoped tiers, all durable, all enforced:

| Scope | Shape | Lifetime |
|-------|-------|----------|
| Global | One JSON row per clog | Forever |
| Session | One JSON row per (clog, session) | Until session deleted |
| Run | One JSON row per (clog, run) | Until run deleted |
| Tick | Many rows per (clog, run, tick) | Until tick deleted |

Delete a session and everything underneath cascades away — runs, ticks, storage, all of it. Events (audit log) stick around on their own TTL.

**Read-before-write** — You can't write a row you haven't read in the same tick. Each clog gets exactly one read call and one write call per tick, forcing a clean structure:

1. **Read** — gather your inputs
2. **Compute** — do the work, stream events
3. **Write** — commit your outputs

No blind writes. No clobbered state. Full auditability.

### Clogs (the adapters)

A clog is Ocean's unit of modularity. Each clog:

- Has an `id`, endpoint handlers, and an optional `onAdvance` handler
- Gets its own storage budget per tick (isolated from other clogs)
- Interacts with the world strictly through **tools** (storage, events, cross-clog calls)
- Can call other clogs via `ocean.clog.call`
- Controls run lifecycle via `TickOutcome` (ok, done, continue, wait, retry, failed)

You compose capabilities by wiring clogs together:

```
clog.chat.onMessage
  -> calls clog.search.query
  -> calls clog.memory.recall
  -> emits streaming deltas
  -> writes updated conversation state
```

Each clog in the chain gets its own fresh storage budget. Boundaries are explicit. State is durable. Nothing is hidden.

## Quick start

```ts
import { createOcean, createLibsqlDb } from "./ocean/index.js";
import { chatClog } from "./ocean/examples/chat_clog.js";

// One SQLite file. That's your entire backend.
const { db } = createLibsqlDb({ url: "file:./ocean.db" });
const ocean = createOcean({ db });

await ocean.migrate();
ocean.registerClog(chatClog);

// Create a run owned by the chat clog
const { runId } = await ocean.createRun({
  sessionId: "user_123",
  clogId: "chat",
  input: { userText: "Hello!" },  // starts in "pending" status
});

// Process it — calls chatClog.onAdvance with the input
await ocean.advance();

// Check the run
const info = await ocean.getRun(runId);
// => { status: "idle", attempt: 0, ... }

// Send another message
await ocean.signal(runId, { userText: "Tell me more" });
await ocean.advance();

// Read back the streaming events
const events = await ocean.readEvents({
  scope: { kind: "run", runId },
  afterSeq: 0,
});
```

### Direct invocation (alternative)

For synchronous request/response calls that bypass the state machine:

```ts
const { runId } = await ocean.createRun({ sessionId: "user_123", clogId: "chat" });
const { tickId } = await ocean.beginTick({ runId });
const result = await ocean.callClog({
  runId, tickId,
  clogId: "chat",
  method: "onMessage",
  payload: { runId, tickId, userText: "Hello!" },
});
```

## Serverless and one-click deploys

Ocean is designed for environments where you have **zero infrastructure guarantees**:

- **No long-running processes** — work happens in request-scoped ticks
- **No background threads** — everything is driven by incoming requests
- **No in-memory state** — all state lives in the database
- **No cron required** — event TTL cleanup runs opportunistically

This means Ocean Clog works out of the box with:

- **Vercel** / **Netlify** — serverless functions + Turso (hosted libSQL)
- **Cloudflare Workers** — with D1 or Turso
- **Railway** / **Render** / **Fly.io** — persistent SQLite or Turso
- **Your laptop** — `file:./ocean.db` and you're done

One database URL. One deploy. That's it.

```ts
// Local development
createLibsqlDb({ url: "file:./ocean.db" });

// Production (Turso)
createLibsqlDb({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

## Writing a clog

A clog is an object with an `id`, an optional `onAdvance` handler, and endpoint handlers:

```ts
import type { Clog, TickOutcome } from "./ocean/index.js";

const searchClog: Clog = {
  id: "search",

  // Called by advance() when this clog's run has pending work
  async onAdvance(input, { tools, attempt }): Promise<TickOutcome> {
    const { query } = (input ?? {}) as { query?: string };
    if (!query) return { status: "ok" };

    // Read state, do work, write results
    const read = await tools({
      name: "ocean.storage.read_scoped",
      input: { plans: [{ kind: "run" }] },
    });
    if (!read.ok) return { status: "retry", error: read.error.message };

    const results = await fetchSearchResults(query);

    await tools({
      name: "ocean.events.emit",
      input: {
        scope: { kind: "run" },
        type: "search.results",
        payload: { count: results.length },
      },
    });

    // Return "done" — or "ok" to idle, "continue" for more work, "wait" to sleep
    return { status: "done", output: { results } };
  },

  // Direct-invocation endpoints (called via ocean.callClog)
  endpoints: {
    async query(payload, ctx) {
      const results = await fetchSearchResults(payload.query);
      return { ok: true, results };
    },
  },
};
```

## Project structure

```
ocean/                  — the runtime
  ocean.ts              — createOcean() entry point (signal, advance, getRun, etc.)
  index.ts              — public API exports
  db/
    schema.ts           — Drizzle schema (8 tables)
    libsql.ts           — libSQL/Turso adapter
    drizzle/            — generated migrations
  engine/
    run.ts              — run CRUD, signal, acquire/release locking
    tick.ts             — tick management
    events.ts           — event emit, read, TTL cleanup
  storage/
    storage.ts          — low-level CRUD (all 4 scopes)
    read_scoped.ts      — batched read + RBW ledger
    write_scoped.ts     — batched write + RBW enforcement (transactional)
    history.ts          — bulk tick history for hydration
  clogs/
    types.ts            — Clog, TickOutcome, AdvanceHandler types
    registry.ts         — clog registration
    runtime.ts          — tool invoker dispatch
  tools/                — ocean.storage.*, ocean.events.*, ocean.clog.*
  core/
    ids.ts              — random ID generation
    time.ts             — time utilities
    errors.ts           — error types
  examples/
    chat_clog.ts               — basic chat clog (endpoints + onAdvance)
    long_running_chat_agent.ts — persistent chat via signal/advance
    hn_digest_clog.ts          — periodic HN scrape → WhatsApp (multi-tick)
    task_manager_agent.ts      — agent that manages scheduled tasks

app/                    — SvelteKit frontend (scaffolded)
```

## Tech stack

- **Bun** — runtime
- **libSQL / Turso** — database (SQLite-compatible, local or hosted)
- **Drizzle ORM** — typed schema, migrations, query builder
- **SvelteKit** — frontend (scaffolded)
- **Zero external services besides SQLite** — no Redis, no queues, no pub/sub


