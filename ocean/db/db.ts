import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { sql } from "drizzle-orm";

export type SqlClient = LibSQLDatabase;

export async function enableForeignKeys(db: SqlClient): Promise<void> {
  // SQLite/libSQL: FK enforcement is per-connection.
  await db.execute(sql`PRAGMA foreign_keys = ON;`);
}
