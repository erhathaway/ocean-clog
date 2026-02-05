import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/drizzle",
  dialect: "sqlite",
  driver: "libsql",
  dbCredentials: {
    url: process.env.TURSO_DATABASE_URL ?? process.env.LIBSQL_URL ?? "file:./ocean.db",
    authToken: process.env.TURSO_AUTH_TOKEN ?? process.env.LIBSQL_AUTH_TOKEN,
  },
});
