-- Phase 3: Team Collaboration
-- task_comments + notifications

-- ─── task_comments ────────────────────────────────────────────────────────────

CREATE TABLE task_comments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id         uuid          NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_clerk_id varchar(255)  NOT NULL,
  body            text          NOT NULL CHECK (char_length(body) >= 1 AND char_length(body) <= 5000),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id);

CREATE TRIGGER trg_task_comments_updated_at
  BEFORE UPDATE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── notifications ────────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id        uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient_clerk_id  varchar(255)  NOT NULL,
  type                varchar(100)  NOT NULL,   -- task_assigned | comment_added | review_submitted
  title               text          NOT NULL,
  body                text,
  link                text,
  read_at             timestamptz,
  created_at          timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_recipient ON notifications(workspace_id, recipient_clerk_id);
CREATE INDEX idx_notifications_unread    ON notifications(workspace_id, recipient_clerk_id) WHERE read_at IS NULL;
