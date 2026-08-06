-- Give every existing member the new 1,000 point starting balance.
-- Wrangler records applied migrations, so this adjustment runs exactly once.
UPDATE members
SET score = score + 1000,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (
  SELECT 1 FROM score_ledger
  WHERE score_ledger.award_key = 'base:' || members.id
);

INSERT OR IGNORE INTO score_ledger
  (award_key, member_id, kind, points, score_date, activity_event_id, note, created_at)
SELECT
  'base:' || id,
  id,
  'admin_adjustment',
  1000,
  substr(datetime(joined_at, '+9 hours'), 1, 10),
  NULL,
  'starting_score',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM members;

-- Deletions use a separate idempotency table so the original activity and
-- score ledgers remain immutable and auditable.
CREATE TABLE IF NOT EXISTS problem_deletions (
  event_id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  problem_key TEXT NOT NULL,
  occurred_at TEXT,
  server_date TEXT NOT NULL,
  client_version TEXT NOT NULL DEFAULT '',
  processed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS problem_deletion_member_idx
  ON problem_deletions(member_id, problem_key);
