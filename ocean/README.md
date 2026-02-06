# Ocean

Ocean is a persistence-first runtime for building resumable runs with streaming output, designed for serverless/tick-driven environments.

Core goals:
- **Simplicity & elegance**: small, explicit primitives
- **Power**: modular adapters ("clogs"), scoped durable storage, append-only audit log
- **Resumability**: bounded work per tick, durable run state
- **Streaming**: append-only `events` table suitable for SSE/polling

## Concepts

### Runs
A run is a durable state machine identified by `runId` and associated to a `sessionId`.

Each run is owned by a single clog (`clog_id`). That clog handles all lifecycle for the run — processing signals, deciding outcomes, managing retries.

Ocean advances work in ticks. A tick is created when you want to process a discrete interaction (e.g. a chat message).

### Ticks
A tick is a discrete unit of progress/interaction inside a run identified by `tickId`.

Ticks are first-class rows in `ocean_ticks` so tick-scoped storage can be protected by foreign keys and cascade deletion.

### Events (audit log)
Ocean persists an append-only `events` log.

Events are retained as an audit log and are **not** part of foreign key cascades. They are cleaned up by TTL based on creation time (`ts`) when/if an optional cleanup routine runs.

### Clogs (adapters)
A clog is Ocean's adapter unit. Clogs expose callable endpoints and can orchestrate agents/capabilities. Clogs interact with storage and the outside world strictly via **tools**.

Each clog can register an `onAdvance` handler that Ocean calls when a run owned by that clog needs work.

## Storage model

Ocean provides fixed tables only; clogs cannot create tables.

Scopes:
- Global: **one row per clog** (`ocean_storage_global`)
- Session: **one row per (clog, session)** (`ocean_storage_session`)
- Run: **one row per (clog, run)** (`ocean_storage_run`)
- Tick: **many rows per (clog, run, tick)** addressed by `row_id` (`ocean_storage_tick`)

Cascade deletes (FK + `ON DELETE CASCADE`):
- Deleting a **session entity** cascades to its runs, ticks, and their storage rows
- Deleting a **run entity** cascades to its ticks and their storage rows
- Deleting a **tick entity** cascades to its tick storage rows

Events do **not** cascade (audit log).

## Storage access policy (exact-row RBW)

Per clog per tick:
- exactly **one** `ocean.storage.read_scoped` tool call
- exactly **one** `ocean.storage.write_scoped` tool call

RBW (read-before-write, exact row):
- you may only write/delete a row if you read that **exact row** earlier in the same tick
- global/session/run are single rows: you must read the row before writing/clearing it
- tick storage rows are keyed by `row_id`: you must read the exact `(row_id)` before writing/deleting it

Bulk/history reads are allowed but do not unlock writes.

---

## Background execution model

Ocean is fully opportunistic. It only does work when something pokes it — an HTTP request, a cron ping, a webhook, anything. There are no background workers, no message queues, no long-running processes. The run's `status` field IS the queue.

### The state machine

Every run has a status that drives what happens next:

```
idle ──signal──→ pending ──lock──→ active ──outcome──→ idle      (done for now, waiting for next signal)
                                                    → done      (terminal success)
                                                    → pending   (more work, re-advance next poke)
                                                    → waiting   (sleep until wake_at, then re-advance)
                                                    → pending   (retry after backoff)
                                                    → failed    (retries exhausted, terminal)
```

Six statuses: `idle`, `pending`, `active`, `waiting`, `done`, `failed`.

### How work flows

```
Signal arrives (user message, webhook, cron, whatever)
  → run.status becomes "pending"

Ocean gets poked (any request, cron, explicit call)
  → advance() finds pending runs
  → locks the run (with TTL)
  → creates a tick, calls the clog's onAdvance handler
  → clog returns an outcome
  → outcome drives the next status transition
  → lock released
```

### Clog outcomes

The clog controls what happens next by returning an **outcome**:

```ts
type TickOutcome =
  | { status: "ok" }                          // → idle (waiting for next external signal)
  | { status: "done"; output?: unknown }      // → done (terminal)
  | { status: "continue"; input?: unknown }   // → pending (pick up again next advance)
  | { status: "wait"; wakeAt: number }        // → waiting (pick up after wakeAt)
  | { status: "retry"; error: string }        // → pending + backoff (or failed if exhausted)
  | { status: "failed"; error: string }       // → failed (terminal)
```

This gives clogs full control over flow — continue, sleep, retry, fail, complete — without Ocean needing to understand what the clog is doing.

### Locking

Run-level lock with TTL. Two fields on `runs`:

- `locked_by` — instance ID (null when free)
- `lock_expires_at` — timestamp (null when free)

Acquire atomically:
```sql
UPDATE runs SET locked_by = ?, lock_expires_at = ?, status = 'active'
WHERE run_id = ? AND status IN ('pending', 'waiting')
  AND (locked_by IS NULL OR lock_expires_at < now)
  AND (wake_at IS NULL OR wake_at <= now)
```

If the instance crashes, the lock expires and the next poke picks it up. The run is still `active` with an expired lock — `advance()` treats that as available.

### Signals

`signal(runId, input)` is how the outside world drives work into a run.

User sends a message? `signal(runId, { text: "hello" })`. Webhook fires? `signal(runId, { data: ... })`.

Signal writes `pending_input` to the run and flips status to `pending`:

```sql
UPDATE runs SET
  pending_input = ?,
  status = CASE
    WHEN status = 'idle' THEN 'pending'
    WHEN status = 'waiting' THEN 'pending'
    ELSE status  -- leave active/pending alone
  END
WHERE run_id = ?
```

When `advance()` picks up the run, it passes `pending_input` to the clog and clears it. If a signal arrives while the run is active (locked), the input is stored but status doesn't change. When the current tick finishes and the clog returns "ok" (idle), Ocean checks for a new `pending_input` and re-transitions to `pending` automatically.

Signals never get lost.

### Retry policy

On `{ status: "retry" }`:
1. Increment `attempt` on the run
2. If `attempt >= max_attempts` → transition to `failed`
3. Else → `pending` with `wake_at = now + backoff(attempt)`

Default policy: 3 attempts, exponential backoff (1s, 2s, 4s... capped at 60s). Configurable per-run at creation time.

The clog can inspect `attempt` in its context and decide to try a completely different approach on attempt 2 vs attempt 1 — different model, different prompt, different strategy. The clog can also return `{ status: "failed" }` to skip retries entirely, or `{ status: "retry" }` to request one. The clog outcome is always the final word.

### Run ownership

Each run stores a `clog_id`. That clog's `onAdvance` handler is what `advance()` calls. One run, one clog, one handler. The clog dispatches internally based on the signal it receives.

Cross-clog calls still happen via `ocean.clog.call` within a tick — a chat clog can call a search clog, a memory clog, etc. But the chat clog owns the run and controls the flow.

### The API surface

Three primitives for the state machine:

```ts
// Drive work into a run
ocean.signal(runId: string, input?: unknown): Promise<void>

// Process whatever needs work. Call from anywhere.
ocean.advance(opts?: { budgetMs?: number }): Promise<AdvanceResult>

// Read run status
ocean.getRun(runId: string): Promise<RunInfo | null>
```

Plus the existing direct-invocation API for synchronous calls:

```ts
// Direct clog invocation (bypasses state machine)
ocean.callClog({ runId, tickId, clogId, method, payload }): Promise<unknown>
```

Both patterns coexist. `signal`/`advance` is the primary pattern for durable, recoverable execution. `callClog` is for direct invocation when you want a result in the same request.

### Run creation

```ts
ocean.createRun({
  sessionId: string;
  clogId: string;                // which clog owns this run
  input?: unknown;               // initial pending_input (sets status to "pending")
  retry?: {
    maxAttempts?: number;        // default 3
    backoffMs?: number;          // default 1000
    backoffMaxMs?: number;       // default 60000
  };
}): Promise<{ runId: string }>
```

### Schema additions

New fields on `runs`:

| Field | Type | Description |
|-------|------|-------------|
| `clog_id` | text | Owning clog |
| `locked_by` | text, nullable | Instance holding the lock |
| `lock_expires_at` | integer, nullable | Lock TTL timestamp |
| `attempt` | integer | Current retry attempt (0 = first try) |
| `max_attempts` | integer | Max retries before failed |
| `wake_at` | integer, nullable | Don't advance until this time |
| `pending_input` | text (JSON), nullable | Signal payload awaiting processing |
| `last_error` | text, nullable | Error from last failed attempt |
