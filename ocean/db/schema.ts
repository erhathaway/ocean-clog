import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const oceanSessions = sqliteTable("ocean_sessions", {
  session_id: text("session_id").primaryKey(),
  created_ts: integer("created_ts").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    run_id: text("run_id").primaryKey(),
    created_ts: integer("created_ts").notNull(),
    updated_ts: integer("updated_ts").notNull(),
    session_id: text("session_id")
      .notNull()
      .references(() => oceanSessions.session_id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    state: text("state", { mode: "json" }).notNull(),
  },
  (t) => ({
    idx_runs_session: index("idx_runs_session").on(t.session_id),
  }),
);

export const oceanTicks = sqliteTable(
  "ocean_ticks",
  {
    run_id: text("run_id")
      .notNull()
      .references(() => runs.run_id, { onDelete: "cascade" }),
    tick_id: text("tick_id").notNull(),
    created_ts: integer("created_ts").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.run_id, t.tick_id] }),
    idx_ticks_run: index("idx_ticks_run").on(t.run_id),
  }),
);

export const oceanStorageGlobal = sqliteTable("ocean_storage_global", {
  clog_id: text("clog_id").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updated_ts: integer("updated_ts").notNull(),
});

export const oceanStorageSession = sqliteTable(
  "ocean_storage_session",
  {
    clog_id: text("clog_id").notNull(),
    session_id: text("session_id")
      .notNull()
      .references(() => oceanSessions.session_id, { onDelete: "cascade" }),
    value: text("value", { mode: "json" }).notNull(),
    updated_ts: integer("updated_ts").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clog_id, t.session_id] }),
    idx_storage_session_session: index("idx_storage_session_session").on(t.session_id),
  }),
);

export const oceanStorageRun = sqliteTable(
  "ocean_storage_run",
  {
    clog_id: text("clog_id").notNull(),
    run_id: text("run_id")
      .notNull()
      .references(() => runs.run_id, { onDelete: "cascade" }),
    value: text("value", { mode: "json" }).notNull(),
    updated_ts: integer("updated_ts").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clog_id, t.run_id] }),
    idx_storage_run_run: index("idx_storage_run_run").on(t.run_id),
  }),
);

export const oceanStorageTick = sqliteTable(
  "ocean_storage_tick",
  {
    clog_id: text("clog_id").notNull(),
    run_id: text("run_id").notNull(),
    tick_id: text("tick_id").notNull(),
    row_id: text("row_id").notNull(),
    value: text("value", { mode: "json" }).notNull(),
    updated_ts: integer("updated_ts").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.clog_id, t.run_id, t.tick_id, t.row_id] }),
    fk_tick: foreignKey({
      columns: [t.run_id, t.tick_id],
      foreignColumns: [oceanTicks.run_id, oceanTicks.tick_id],
    }).onDelete("cascade"),
    idx_storage_tick_run_tick: index("idx_storage_tick_run_tick").on(t.run_id, t.tick_id),
    idx_storage_tick_run: index("idx_storage_tick_run").on(t.run_id),
  }),
);

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    ts: integer("ts").notNull(),
    scope_kind: text("scope_kind").notNull(),
    session_id: text("session_id"),
    run_id: text("run_id"),
    tick_id: text("tick_id"),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
  },
  (t) => ({
    idx_events_id: uniqueIndex("idx_events_id").on(t.id),
    idx_events_ts: index("idx_events_ts").on(t.ts),
    idx_events_run_seq: index("idx_events_run_seq").on(t.run_id, t.seq),
    idx_events_session_seq: index("idx_events_session_seq").on(t.session_id, t.seq),
  }),
);
