BEGIN;
-- Epic retrospectives, mirroring sprint_retros — epics are a bigger unit of work than tasks
-- and had no post-mortem/reflection mechanism at all.
CREATE TABLE IF NOT EXISTS epic_retros (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  epic_id      UUID        NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  went_well    TEXT,
  to_improve   TEXT,
  action_items TEXT,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT epic_retros_unique UNIQUE (epic_id)
);

CREATE INDEX IF NOT EXISTS epic_retros_workspace_idx ON epic_retros(workspace_id);
COMMIT;
