export const OCEAN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_expires_ts INTEGER,
  leased_by TEXT,
  wake_ts INTEGER,
  state TEXT NOT NULL,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_runnable
  ON runs(status, wake_ts, lease_expires_ts, updated_ts);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_events_scope_seq ON events(scope_kind, scope_id, seq);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);
`;