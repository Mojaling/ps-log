-- Store only the problem fields that members explicitly share on the team page.
-- Personal notes, review notes, and GitHub data remain outside D1.
-- Optional team-shared solution code is added separately in migration 0006.
ALTER TABLE problem_states ADD COLUMN site TEXT NOT NULL DEFAULT '';
ALTER TABLE problem_states ADD COLUMN problem_number TEXT NOT NULL DEFAULT '';
ALTER TABLE problem_states ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE problem_states ADD COLUMN difficulty TEXT NOT NULL DEFAULT '';
ALTER TABLE problem_states ADD COLUMN link TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS problem_state_member_updated_idx
  ON problem_states(member_id, updated_at DESC);
