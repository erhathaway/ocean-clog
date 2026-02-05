# Ocean migrations

Ocean ships a single SQL schema file:

- `ocean/migrations/schema.sql`

You should apply it using your existing migration system (recommended), or by running the SQL at startup for dev/test.

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

### Option A: Migration tool (recommended)
Put `ocean/migrations/schema.sql` into your migrations directory and run it once.

### Option B: Apply at startup (dev/test)
Pseudo-code:

```ts
import fs from "node:fs/promises";
import { sql } from "drizzle-orm";
import { enableForeignKeys } from "./ocean/db/db.js";

await enableForeignKeys(db);
const schemaSql = await fs.readFile(new URL("./ocean/migrations/schema.sql", import.meta.url), "utf8");
await db.execute(sql.raw(schemaSql));
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
