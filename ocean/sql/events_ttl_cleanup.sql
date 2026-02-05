DELETE FROM events
WHERE ts < ?1;