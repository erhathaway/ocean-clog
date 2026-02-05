# Clogs and tools

A **clog** is an adapter module that registers callable endpoints.

Clogs run with a `ToolInvoker` and must use tools for storage/events/cross-clog calls.

## Tool budget per tick (storage)
Per clog, per tick:
- exactly one `ocean.storage.read_scoped`
- exactly one `ocean.storage.write_scoped`

Other tools (`ocean.events.emit`, `ocean.clog.call`, etc.) are unlimited.

## RBW (exact-row read-before-write)
Writes are accepted only if the exact target row was read earlier in the same tick.

Targets:
- Global row: `ocean_storage_global` row for that clog
- Session row: `ocean_storage_session` row for `(clog, session)`
- Run row: `ocean_storage_run` row for `(clog, run)`
- Tick row: `ocean_storage_tick` row for `(clog, run, tick, row_id)`

Bulk reads (history) do not unlock writes.

## Tools
### `ocean.storage.read_scoped`
Read exact rows (and optionally bulk tick history for hydration). Exact row reads unlock exact row writes.

### `ocean.storage.write_scoped`
Apply sets/deletes/clears for rows previously read.

Also supports deleting *entities* (session/run/tick) which triggers FK cascades:
- `session.delete` deletes the session entity and cascades to runs/ticks/storage
- `run.delete` deletes the run entity and cascades to ticks/storage
- `tick.delete` deletes the tick entity and cascades to tick storage

### `ocean.events.emit`
Append an event to the audit log. No RBW.

### `ocean.clog.call`
Call another clog endpoint by address `clog.<id>.<method>`. Calls share the same tick context; each clog gets its own storage budget.