CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  ts INTEGER NOT NULL,

  scope_kind TEXT NOT NULL,   -- 'global' | 'session' | 'run' | 'tick'
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