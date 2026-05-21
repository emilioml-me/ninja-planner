-- Migration 015: Story points on tasks
-- Optional fibonacci-style estimate (0–144).

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS story_points INTEGER
  CHECK (story_points IS NULL OR (story_points >= 0 AND story_points <= 144));
