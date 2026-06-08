-- Track which task a recurring spawn originated from.
-- Replaces the fragile title+rule dedup with an ID-based dedup that
-- cannot produce false positives when two tasks share the same title.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS spawned_from_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_spawned_from
  ON tasks(workspace_id, spawned_from_id, created_at DESC)
  WHERE spawned_from_id IS NOT NULL;
