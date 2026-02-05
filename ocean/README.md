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

Ocean advances work in ticks. A tick is created when you want to process a discrete interaction (e.g. a chat message).

### Ticks
A tick is a discrete unit of progress/interaction inside a run identified by `tickId`.

Ticks are first-class rows in `ocean_ticks` so tick-scoped storage can be protected by foreign keys and cascade deletion.

### Events (audit log)
Ocean persists an append-only `events` log.

Events are retained as an audit log and are **not** part of foreign key cascades. They are cleaned up by TTL based on creation time (`ts`) when/if an optional cleanup routine runs.

### Clogs (adapters)
A clog is Ocean's adapter unit. Clogs expose callable endpoints and can orchestrate agents/capabilities. Clogs interact with storage and the outside world strictly via **tools**.

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