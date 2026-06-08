-- Speed up recurring-task queries filtered by recurrence_rule.
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence
  ON tasks(workspace_id, recurrence_rule, created_at DESC)
  WHERE deleted_at IS NULL AND recurrence_rule IS NOT NULL;
