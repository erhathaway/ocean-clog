CREATE TABLE IF NOT EXISTS ocean_storage_global (
  clog_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_ts INTEGER NOT NULL
);