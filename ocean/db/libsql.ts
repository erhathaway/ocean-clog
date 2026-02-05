import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

export type LibsqlDb = { db: LibSQLDatabase; client: Client };

export function createLibsqlDb(opts: { url: string; authToken?: string }): LibsqlDb {
  const client = createClient({ url: opts.url, authToken: opts.authToken });
  const db = drizzle(client);
  return { db, client };
}
