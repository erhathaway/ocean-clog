CREATE TABLE IF NOT EXISTS addr_kv (
  scope TEXT NOT NULL,          -- e.g. "clog.chat"
  key TEXT NOT NULL,            -- e.g. "model", "timeoutMs"
  value TEXT NOT NULL,          -- JSON string
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS secrets_kv (
  scope TEXT NOT NULL,          -- e.g. "clog.chat"
  key TEXT NOT NULL,
  value TEXT NOT NULL,          -- encrypted or provider-managed secret reference
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);