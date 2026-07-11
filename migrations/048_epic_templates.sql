-- Epic templates: a project-kickoff blueprint composing an epic shell with a set of task
-- templates (and optionally a sprint template) that get instantiated together via /use.
BEGIN;

CREATE TABLE IF NOT EXISTS epic_templates (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  epic_title         TEXT        NOT NULL CHECK (char_length(epic_title) BETWEEN 1 AND 500),
  epic_description   TEXT,
  epic_color         TEXT        NOT NULL DEFAULT '#6366f1',
  sprint_template_id UUID        REFERENCES sprint_templates(id) ON DELETE SET NULL,
  created_by         TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS epic_template_tasks (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  epic_template_id UUID        NOT NULL REFERENCES epic_templates(id) ON DELETE CASCADE,
  task_template_id UUID        NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
  position         INT         NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS epic_templates_workspace_idx ON epic_templates(workspace_id);
CREATE INDEX IF NOT EXISTS epic_template_tasks_template_idx ON epic_template_tasks(epic_template_id);

COMMIT;
