-- One row per clog
CREATE TABLE IF NOT EXISTS ocean_storage_global (
  clog_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,          -- JSON
  updated_ts INTEGER NOT NULL
);

-- One row per (clog, session)
CREATE TABLE IF NOT EXISTS ocean_storage_session (
  clog_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  value TEXT NOT NULL,          -- JSON
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (clog_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_ocean_storage_session_lookup
  ON ocean_storage_session (session_id);

-- One row per (clog, run), includes parent session reference
CREATE TABLE IF NOT EXISTS ocean_storage_run (
  clog_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  value TEXT NOT NULL,          -- JSON
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (clog_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_ocean_storage_run_lookup
  ON ocean_storage_run (run_id);

-- Many rows per (clog, run, tick), addressed by row_id
CREATE TABLE IF NOT EXISTS ocean_storage_tick (
  clog_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  session_id TEXT NOT NULL,

  row_id TEXT NOT NULL,         -- the only "keyed" scope
  value TEXT NOT NULL,          -- JSON
  updated_ts INTEGER NOT NULL,

  PRIMARY KEY (clog_id, run_id, tick_id, row_id)
);

CREATE INDEX IF NOT EXISTS idx_ocean_storage_tick_lookup
  ON ocean_storage_tick (run_id, tick_id);