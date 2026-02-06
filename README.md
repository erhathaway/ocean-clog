# Ocean Clog

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

No Redis. No message queues. No background workers. One database and your clogs.

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

Ocean provides the execution substrate:

**Runs** — A durable state machine. One per conversation, workflow, or task.

**Ticks** — A bounded unit of progress inside a run. One per user message, one per webhook, one per cron hit. Work happens in ticks.

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

- Has an `id` and a set of endpoint handlers
- Gets its own storage budget per tick (isolated from other clogs)
- Interacts with the world strictly through **tools** (storage, events, cross-clog calls)
- Can call other clogs via `ocean.clog.call`

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

// Create a conversation
const { runId } = await ocean.createRun({ sessionId: "user_123" });

// Process a message (one tick of work)
const { tickId } = await ocean.beginTick({ runId });
const result = await ocean.callClog({
  runId, tickId,
  clogId: "chat",
  method: "onMessage",
  payload: { runId, tickId, userText: "Hello!" },
});

// Read back the streaming events
const events = await ocean.readEvents({
  scope: { kind: "run", runId },
  afterSeq: 0,
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

A clog is just an object with an id and endpoint handlers:

```ts
import type { Clog } from "./ocean/index.js";

const searchClog: Clog = {
  id: "search",
  endpoints: {
    async query(payload, ctx) {
      // 1. Read — get run state + reserve tick rows
      const read = await ctx.tools({
        name: "ocean.storage.read_scoped",
        input: {
          plans: [
            { kind: "run", runId: payload.runId },
            { kind: "tick_rows", runId: payload.runId, tickId: payload.tickId, rowIds: ["results"] },
          ],
        },
      });

      // 2. Compute — do the actual work, emit events
      const results = await fetchSearchResults(payload.query);

      await ctx.tools({
        name: "ocean.events.emit",
        input: {
          scope: { kind: "run", runId: payload.runId },
          type: "search.results",
          payload: { count: results.length },
        },
      });

      // 3. Write — persist results into tick storage
      await ctx.tools({
        name: "ocean.storage.write_scoped",
        input: {
          ops: [
            { op: "tick.set", runId: payload.runId, tickId: payload.tickId, rowId: "results", value: results },
          ],
        },
      });

      return { ok: true, results };
    },
  },
};
```

## Project structure

```
ocean/                  — the runtime
  ocean.ts              — createOcean() entry point
  index.ts              — public API exports
  db/
    schema.ts           — Drizzle schema (7 tables)
    libsql.ts           — libSQL/Turso adapter
    drizzle/            — generated migrations
  engine/
    run.ts              — run + session CRUD
    tick.ts             — tick management
    events.ts           — event emit, read, TTL cleanup
  storage/
    storage.ts          — low-level CRUD (all 4 scopes)
    read_scoped.ts      — batched read + RBW ledger
    write_scoped.ts     — batched write + RBW enforcement (transactional)
    history.ts          — bulk tick history for hydration
  clogs/
    types.ts            — Clog + ClogHandler types
    registry.ts         — clog registration
    runtime.ts          — tool invoker dispatch
  tools/                — ocean.storage.*, ocean.events.*, ocean.clog.*
  examples/
    chat_clog.ts        — complete chat clog example

app/                    — SvelteKit frontend (scaffolded)
```

## Tech stack

- **Bun** — runtime
- **libSQL / Turso** — database (SQLite-compatible, local or hosted)
- **Drizzle ORM** — typed schema, migrations, query builder
- **SvelteKit** — frontend (scaffolded)
- **Zero external services besides SQLite** — no Redis, no queues, no pub/sub


