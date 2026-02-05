CREATE TABLE IF NOT EXISTS ocean_storage_session (
  clog_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (clog_id, session_id),

  FOREIGN KEY (session_id) REFERENCES ocean_sessions(session_id) ON DELETE CASCADE
);