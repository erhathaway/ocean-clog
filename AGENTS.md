# Agents in Ocean

**IMPORTANT:** Do not work on /app only work in /ocean. 
**IMPORTANT:** Ocean uses Bun + libSQL + Drizzle. When `ocean/db/schema.ts` changes, always run `bunx drizzle-kit generate --config ocean/drizzle.config.ts` and include the generated migration output in your changes.

This document explains the **spirit** and **shape** of “agents” in Ocean: what they are, how they run, how they persist state, and why the system is designed the way it is.

Ocean’s agent model is intentionally simple:
- an agent is just code (usually exposed via a clog endpoint)
- it can read durable state, compute, emit events, and write durable state
- it runs inside a **tick** so execution is naturally bounded and resumable

The “power” comes from strong constraints:
- fixed, Ocean-owned persistence tables (no per-clog schema drift)
- explicit tool calls
- read-before-write enforced per tick (RBW)
- an append-only audit log for streaming and forensic debugging

---

## The idea: resumable, serverless-friendly computation

Ocean is designed for environments where you **cannot rely on**:
- long-running processes
- background threads
- cron jobs
- in-memory state surviving between requests

Instead, Ocean assumes:
- work happens when something “pokes” the system (HTTP request, SSE connect, poll, webhook, etc.)
- each poke advances the world a little bit
- everything important is persisted

A *run* is the durable container for a piece of work (a conversation, a workflow, a plan).
A *tick* is one bounded slice of progress for that run.

### Chat as a first-class mapping
For chat, a clean mapping is:
- each incoming user message is a **tick**
- the system processes that tick (planning, tool use, generation)
- the UI streams deltas from the `events` audit log

This gives you:
- deterministic “one message → one tick of work”
- clear boundaries for memory (tick vs run)
- natural backpressure and safety (bounded execution per tick)

---

## The spirit: explicitness over magic

Ocean does not try to be a monolithic agent framework with hidden state, hidden background jobs, or implicit memory.
Ocean is a small runtime with a few sharp primitives:

- **Tools** are explicit.
- **Storage** is explicit and scoped.
- **Event emission** is explicit.
- **Cross-module calls** are explicit (clog-to-clog).

This makes the system:
- easier to understand
- easier to audit
- easier to resume
- easier to harden

---

## What is an “agent” here?

In Ocean, “agent” is an architectural role, not a special class:

- A typical agent is implemented as a **clog endpoint** (e.g. `clog.chat.onMessage`).
- That endpoint receives input, then:
  1) reads state using storage tools
  2) computes (often using an LLM, other clogs, or external APIs)
  3) emits streaming events
  4) writes updated state using storage tools

Ocean’s job is not to decide your agent’s personality. Ocean’s job is to ensure:
- state is durable
- boundaries are enforced
- streaming is reliable
- the system stays composable

---

## Clogs: why we have them

A clog is Ocean’s unit of modularity:
- one clog can be “chat”
- one can be “browser”
- one can be “filesystem”
- one can be “planner”
- one can be “memory”
- one can be “billing”
- etc.

Clogs are powerful because they provide:
- separation of concerns
- stable interfaces
- controlled persistence
- composable “capabilities” (via `ocean.clog.call`)

Ocean aims for the elegance of a small kernel: clogs are the “drivers”.

---

## Persistence model (and why it looks like this)

Ocean provides fixed persistence tables and does not allow clogs to create tables.
This is a deliberate choice to keep deployments safe and uniform:
- migrations are stable
- backups are predictable
- you can reason about storage costs
- you can enforce deletion behavior consistently (foreign keys + cascade)

### Storage scopes (conceptual)
Ocean storage is scoped to match how real systems think about state:

- **Global**: shared configuration/cache per clog
- **Session**: user-specific state (preferences, profile, personalization)
- **Run**: durable per-workflow/per-conversation state
- **Tick**: per-interaction/per-message scratchpad and message-local data

### Important simplification in this design
In the current spec:
- **global/session/run scopes each have exactly one row** (a single JSON value)
- **tick scope has many rows**, addressed by `row_id`

This encourages a simple pattern:
- global/session/run = “the current state object”
- tick = “a set of named message-local slots”

---

## RBW: Read-before-write (exact-row)

Ocean enforces a hard rule during each tick:

> You cannot write/delete a row unless you read that exact row earlier in the same tick.

This rule is not about security theater—it creates real engineering advantages:

### 1) Determinism and safety
RBW forces a pattern similar to optimistic concurrency:
- load the current state
- decide how to transform it
- commit the transformation

It prevents “blind writes” that clobber state accidentally.

### 2) Better resumability
Because agents must read before writing each tick, the code naturally re-hydrates state after restarts, timeouts, or partial progress.

### 3) Easier debugging and auditing
Tool calls + RBW give you a clear narrative:
- “what state was read”
- “what was computed”
- “what changed”

Even if the system is distributed later, the same discipline holds.

### 4) Encourages minimal writes
If you have to read a row to write it, you tend to keep the number of rows you mutate small and intentional.

### “Single read + single write” per tick, per clog
Ocean tightens this further:
- per clog per tick: **one** storage read call and **one** storage write call

This yields a clean structure for agent execution:
- **Phase 1**: gather inputs (read)
- **Phase 2**: do the work (compute + other tools + streaming events)
- **Phase 3**: commit outputs (write)

This is elegant and powerful: it’s basically a transactional “plan/commit” shape without requiring you to build a complex transaction DSL.

---

## Foreign keys and cascade deletes: state is a tree

Ocean’s core entities form a tree:

- `session` (root)
  - `run`
    - `tick`

Storage tables are attached to those entities and use foreign keys with `ON DELETE CASCADE` so deleting a parent deletes its children.

This provides:
- strong cleanup semantics (“delete run and all its tick data”)
- consistent behavior across clogs
- fewer footguns (no orphan tick storage)

### Events are not part of the cascade
`events` is an audit log. It is intentionally *not* FK constrained and does not cascade delete.
Events are cleaned with TTL (creation-time-based) instead.

This means:
- you can delete operational state and still keep an audit trail for a while
- you can run cleanup on your own schedule

---

## Events: streaming output + audit trail

Agents typically emit:
- `run.delta` events for streaming user-visible text
- `run.tool_call` / `run.tool_result` / `telemetry.*` events for debugging and observability

Because events are append-only:
- the UI can reliably “tail” them (SSE/poll)
- you can replay history for debugging
- the system is naturally resistant to partial failures

---

## Typical agent patterns

### Pattern A: Chat agent (message = tick)
1) Read:
   - run state (single run row)
   - session prefs (single session row)
   - tick rows needed (`user_message`, maybe `attachments`, maybe `draft`)
   - optionally bulk tick history for hydration (does not unlock writes)

2) Compute:
   - call LLM
   - call other clogs (`browser`, `search`, `tools`)
   - emit `run.delta` as output is produced

3) Write:
   - update run row (durable conversation memory / summary / tool state)
   - set tick rows (final assistant message, tool traces, structured outputs)

### Pattern B: Planner/Executor split
- Planner clog reads run row and certain tick rows, then writes a plan into a tick row.
- Executor clog reads that plan row and writes results into other tick rows and/or updates the run row.

RBW makes the handoff explicit: you can’t mutate a row you didn’t read.

### Pattern C: Memory promotion
- tick rows are message-local and potentially large/verbose
- run row is curated and compact (summary, distilled facts, tool registry)
- end of tick: promote the parts you want to keep into the run row

---

## Bulk hydration (previous ticks)

Ocean supports reading previous ticks (e.g. for chat history hydration).
This is intentionally modeled as a **bulk read**:
- it is useful for context construction
- it does **not** grant permission to write any rows
- writes still require explicit exact-row reads (RBW)

This avoids subtle bugs like:
- “I loaded history so now I’m allowed to mutate it”
No—mutations always require explicit reads of the exact rows.

---

## Design guidance for writing good agents

### Keep the run row small and canonical
Treat the run row as “the truth”:
- compact summary
- structured state
- references/IDs, not huge blobs

Put large/verbose artifacts into:
- tick rows (message-local)
- external blob stores (S3, R2, etc.) referenced by ID

### Be conservative in what you plan to write
Because you must read rows before writing them, decide early which rows you might mutate.
It is totally fine to “read ahead” rows you *might* update in the write phase.

### Emit events generously
Events are cheap and extremely valuable:
- streaming UX
- postmortems
- debugging
- product analytics (with care)

### Make cross-clog calls small and explicit
A cross-clog call is effectively a capability invocation.
Keep payloads and results typed/structured, and store durable results back into run/tick rows.

---

## The north star

Ocean is aiming for a kernel-like runtime:
- minimal primitives
- strong constraints
- composable adapters
- durable state + replayable events
- easy to run in a single instance today
- not painted into a corner if you later need multiple instances

Agents in Ocean should feel:
- straightforward to implement
- easy to reason about
- hard to accidentally break
- capable of sophisticated orchestration through clogs and tools

If you keep the tool surfaces small and the rules strict, you get a system that is both elegant and surprisingly powerful.
