# Ocean migrations

Ocean uses Drizzle with a typed schema in `ocean/db/schema.ts`. Generate and apply migrations from that schema.

## Required: enable foreign keys (SQLite/libSQL)

Ocean relies on foreign keys with `ON DELETE CASCADE` for deleting:
- sessions → runs → ticks → storage children
- runs → ticks → storage children
- ticks → tick storage children

SQLite requires this pragma **per connection**:

```sql
PRAGMA foreign_keys = ON;
```

If you use the `SqlClient` interface in this folder, call:

- `enableForeignKeys(db)` (in `ocean/db/db.ts`)

on each connection before executing any queries.

## Applying the schema

### Drizzle migrations (Bun + libSQL)
Generate migrations from the typed schema:

```sh
bunx drizzle-kit generate --config ocean/drizzle.config.ts
```

Apply migrations at startup:

```ts
import { migrate } from "drizzle-orm/libsql/migrator";

await migrate(db, {
  migrationsFolder: new URL("./ocean/db/drizzle", import.meta.url).pathname,
});
```

## Notes on future migrations
Ocean’s guiding principle is a stable core schema. Prefer additive migrations:
- add columns with defaults
- add new tables only if they are core (not per-clog)
- avoid per-clog tables

## Events retention
Events are an audit log:
- no foreign key constraints
- no cascade deletes
- TTL cleanup is based on creation time (`events.ts`) and can be invoked opportunistically via `ocean.gcEventsIfDue()`.
