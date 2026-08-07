-- Record each missed Todo once so retries and repeated browser reconciliation
-- cannot charge the same member more than once.
CREATE TABLE IF NOT EXISTS todo_failures (
  event_id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  todo_key TEXT NOT NULL,
  due_on TEXT NOT NULL,
  occurred_at TEXT,
  server_date TEXT NOT NULL,
  client_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (member_id, todo_key, due_on)
);

CREATE INDEX IF NOT EXISTS todo_failure_member_date_idx
  ON todo_failures(member_id, due_on);
