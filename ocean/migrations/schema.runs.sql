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
  last_error TEXT,

  FOREIGN KEY (session_id) REFERENCES ocean_sessions(session_id) ON DELETE CASCADE
);