-- Solution code is fetched separately from the problem list to keep ranking responses small.
ALTER TABLE problem_states ADD COLUMN solution_language TEXT NOT NULL DEFAULT '';
ALTER TABLE problem_states ADD COLUMN solution_code TEXT NOT NULL DEFAULT '';

