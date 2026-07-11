BEGIN;
-- Epics had no comment/discussion mechanism despite being a bigger unit of work than tasks
-- (which already have task_comments) — mirrors task_comments' exact shape.
CREATE TABLE IF NOT EXISTS epic_comments (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  epic_id         uuid          NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  author_clerk_id varchar(255)  NOT NULL,
  body            text          NOT NULL CHECK (char_length(body) >= 1 AND char_length(body) <= 5000),
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_epic_comments_epic ON epic_comments(epic_id);

CREATE TRIGGER trg_epic_comments_updated_at
  BEFORE UPDATE ON epic_comments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMIT;
