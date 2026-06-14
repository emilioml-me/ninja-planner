-- Sprint templates: reusable sprint blueprints
CREATE TABLE IF NOT EXISTS sprint_templates (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  goal           TEXT,
  duration_days  INT         NOT NULL DEFAULT 14 CHECK (duration_days BETWEEN 1 AND 90),
  created_by     TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sprint_templates_workspace_idx ON sprint_templates(workspace_id);
