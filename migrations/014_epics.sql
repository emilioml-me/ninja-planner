-- Migration 014: Epics
-- An epic is a large body of work that groups multiple tasks.
-- Tasks optionally belong to an epic via epic_id FK.

CREATE TABLE IF NOT EXISTS epics (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description  TEXT,
  status       TEXT        NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'completed', 'archived')),
  color        TEXT        NOT NULL DEFAULT '#6366f1',
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS epics_workspace_idx ON epics(workspace_id);

-- Link tasks → epics (nullable; SET NULL on epic delete)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS epic_id UUID REFERENCES epics(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_epic_id_idx ON tasks(epic_id) WHERE epic_id IS NOT NULL;
