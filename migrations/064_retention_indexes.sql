-- 064: indexes for the daily retention deletes (retentionService, review M35).
-- None of the existing indexes lead with the timestamp each delete filters on
-- (idx_webhook_deliveries_endpoint is (endpoint_id, created_at), automation_logs_workspace_idx
-- is (workspace_id, ran_at), the notifications indexes don't include read_at), so every run
-- would otherwise seq-scan the largest tables. task_activity is kept (audit history).
CREATE INDEX IF NOT EXISTS webhook_deliveries_created_at_idx ON webhook_deliveries (created_at);

CREATE INDEX IF NOT EXISTS automation_logs_ran_at_idx ON automation_logs (ran_at);

CREATE INDEX IF NOT EXISTS notifications_read_at_idx
  ON notifications (read_at)
  WHERE read_at IS NOT NULL;
