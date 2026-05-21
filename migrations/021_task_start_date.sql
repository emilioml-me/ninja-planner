-- Add start_date to tasks for Gantt / timeline view
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE;
CREATE INDEX IF NOT EXISTS tasks_start_date_idx ON tasks(workspace_id, start_date) WHERE start_date IS NOT NULL;
