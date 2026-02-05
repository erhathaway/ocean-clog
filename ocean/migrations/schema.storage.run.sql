CREATE TABLE IF NOT EXISTS ocean_storage_run (
  clog_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (clog_id, run_id),

  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);