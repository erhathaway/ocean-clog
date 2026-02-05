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