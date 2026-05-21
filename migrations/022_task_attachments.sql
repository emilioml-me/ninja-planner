-- File attachments on tasks, stored in Cloudflare R2
CREATE TABLE IF NOT EXISTS task_attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_name     TEXT        NOT NULL CHECK (char_length(file_name) <= 255),
  file_size     BIGINT      NOT NULL CHECK (file_size >= 0),
  mime_type     TEXT        NOT NULL,
  r2_key        TEXT        NOT NULL,
  uploaded_by   TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_attachments_task_idx      ON task_attachments(task_id);
CREATE INDEX IF NOT EXISTS task_attachments_workspace_idx ON task_attachments(workspace_id);
