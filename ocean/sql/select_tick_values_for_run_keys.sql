SELECT tick_id, key, value, updated_ts
FROM ocean_storage_tick
WHERE clog_id = ?1
  AND run_id = ?2
  AND tick_id IN (/* bound list */)
  AND key IN (/* bound list */);