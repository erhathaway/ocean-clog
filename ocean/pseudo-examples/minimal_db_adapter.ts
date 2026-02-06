import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { createLibsqlDb } from "../db/libsql.js";

/**
 * Minimal libSQL + Drizzle adapter for Bun.
 *
 * Examples:
 * - local file:  createOceanDb({ url: "file:./ocean.db" })
 * - remote:      createOceanDb({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN })
 */
export function createOceanDb(opts: { url: string; authToken?: string }): LibSQLDatabase {
  return createLibsqlDb(opts).db;
}
