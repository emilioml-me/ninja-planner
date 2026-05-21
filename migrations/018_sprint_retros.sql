-- Sprint retrospectives: one structured retro per sprint
CREATE TABLE IF NOT EXISTS sprint_retros (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id    UUID        NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  went_well    TEXT,
  to_improve   TEXT,
  action_items TEXT,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sprint_retros_unique UNIQUE (sprint_id)
);

CREATE INDEX IF NOT EXISTS sprint_retros_workspace_idx ON sprint_retros(workspace_id);
