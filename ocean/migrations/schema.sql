-- Parent entities for cascading deletes

CREATE TABLE IF NOT EXISTS ocean_sessions (
  session_id TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,

  status TEXT NOT NULL,
  state TEXT NOT NULL,

  FOREIGN KEY (session_id) REFERENCES ocean_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

CREATE TABLE IF NOT EXISTS ocean_ticks (
  run_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  created_ts INTEGER NOT NULL,

  PRIMARY KEY (run_id, tick_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticks_run ON ocean_ticks(run_id);

-- Storage tables

CREATE TABLE IF NOT EXISTS ocean_storage_global (
  clog_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ocean_storage_session (
  clog_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,

  PRIMARY KEY (clog_id, session_id),
  FOREIGN KEY (session_id) REFERENCES ocean_sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_storage_session_session ON ocean_storage_session(session_id);

CREATE TABLE IF NOT EXISTS ocean_storage_run (
  clog_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,

  PRIMARY KEY (clog_id, run_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_storage_run_run ON ocean_storage_run(run_id);

CREATE TABLE IF NOT EXISTS ocean_storage_tick (
  clog_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,

  row_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,

  PRIMARY KEY (clog_id, run_id, tick_id, row_id),
  FOREIGN KEY (run_id, tick_id) REFERENCES ocean_ticks(run_id, tick_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_storage_tick_run_tick ON ocean_storage_tick(run_id, tick_id);
CREATE INDEX IF NOT EXISTS idx_storage_tick_run ON ocean_storage_tick(run_id);

-- Events (audit log, TTL cleanup by ts, no FKs)

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,

  scope_kind TEXT NOT NULL, -- 'global'|'session'|'run'|'tick'
  session_id TEXT,
  run_id TEXT,
  tick_id TEXT,

  type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_id ON events(id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);