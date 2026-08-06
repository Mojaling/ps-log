PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  season_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  score INTEGER NOT NULL DEFAULT 1000,
  streak INTEGER NOT NULL DEFAULT 0,
  score_reached_at TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_origins (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  origin TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, origin)
);

CREATE TABLE IF NOT EXISTS invites (
  code_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  invite_hash TEXT,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS problem_states (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  problem_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('failed', 'solved')),
  first_failed_on TEXT,
  solved_on TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, problem_key)
);

CREATE TABLE IF NOT EXISTS review_schedules (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  problem_key TEXT NOT NULL,
  stage INTEGER NOT NULL CHECK (stage IN (3, 7, 21)),
  due_on TEXT NOT NULL,
  completed_on TEXT,
  completed_event_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (member_id, problem_key, stage)
);

CREATE TABLE IF NOT EXISTS activity_events (
  event_id TEXT PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('problem_failed', 'problem_solved', 'review_completed')),
  problem_key TEXT NOT NULL,
  stage INTEGER,
  occurred_at TEXT,
  server_date TEXT NOT NULL,
  client_version TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_member_date_idx
  ON activity_events(member_id, server_date);

CREATE TABLE IF NOT EXISTS score_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  award_key TEXT NOT NULL UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('solve_award', 'review_award', 'streak_bonus', 'daily_penalty', 'admin_adjustment')),
  points INTEGER NOT NULL,
  score_date TEXT NOT NULL,
  activity_event_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS score_member_date_idx
  ON score_ledger(member_id, score_date);

CREATE TABLE IF NOT EXISTS daily_results (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  solved_count INTEGER NOT NULL,
  due_count INTEGER NOT NULL,
  completed_due_count INTEGER NOT NULL,
  mission_met INTEGER NOT NULL CHECK (mission_met IN (0, 1)),
  streak INTEGER NOT NULL,
  points INTEGER NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (member_id, day)
);
