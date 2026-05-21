-- Task watchers: subscribe to updates without being assigned
CREATE TABLE IF NOT EXISTS task_watchers (
  task_id       UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_clerk_id TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_clerk_id)
);

CREATE INDEX IF NOT EXISTS task_watchers_workspace_idx ON task_watchers(workspace_id);
CREATE INDEX IF NOT EXISTS task_watchers_user_idx      ON task_watchers(workspace_id, user_clerk_id);
