CREATE TABLE IF NOT EXISTS ocean_ticks (
  run_id TEXT NOT NULL,
  tick_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_ts INTEGER NOT NULL,

  PRIMARY KEY (run_id, tick_id),

  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES ocean_sessions(session_id) ON DELETE CASCADE
);