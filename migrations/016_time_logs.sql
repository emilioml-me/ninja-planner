-- Time logs: track hours spent on tasks
CREATE TABLE IF NOT EXISTS time_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_clerk_id TEXT        NOT NULL,
  minutes       INTEGER     NOT NULL CHECK (minutes > 0 AND minutes <= 14400), -- max 240 hrs
  note          TEXT,
  logged_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS time_logs_task_idx      ON time_logs(task_id);
CREATE INDEX IF NOT EXISTS time_logs_workspace_idx ON time_logs(workspace_id);
CREATE INDEX IF NOT EXISTS time_logs_user_idx      ON time_logs(workspace_id, user_clerk_id);
