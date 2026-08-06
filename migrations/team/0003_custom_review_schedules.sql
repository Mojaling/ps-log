-- Allow each member to use one to five custom review stages between 1 and 365 days.
-- Existing 3/7/21 schedules and completion history are copied without modification.
PRAGMA foreign_keys = OFF;

CREATE TABLE review_schedules_next (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  problem_key TEXT NOT NULL,
  stage INTEGER NOT NULL CHECK (stage BETWEEN 1 AND 365),
  due_on TEXT NOT NULL,
  completed_on TEXT,
  completed_event_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, problem_key, stage)
);

INSERT INTO review_schedules_next
  (member_id, problem_key, stage, due_on, completed_on, completed_event_id, created_at)
SELECT member_id, problem_key, stage, due_on, completed_on, completed_event_id, created_at
FROM review_schedules;

DROP TABLE review_schedules;
ALTER TABLE review_schedules_next RENAME TO review_schedules;

PRAGMA foreign_keys = ON;
