-- Add billable tracking and budget link to time logs
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS billable        BOOLEAN      NOT NULL DEFAULT false;
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS hourly_rate     NUMERIC(10,2);
ALTER TABLE time_logs ADD COLUMN IF NOT EXISTS budget_entry_id UUID         REFERENCES budget_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS time_logs_budget_entry_idx ON time_logs(budget_entry_id) WHERE budget_entry_id IS NOT NULL;
