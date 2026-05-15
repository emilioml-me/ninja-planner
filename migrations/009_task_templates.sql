-- Migration 009: task templates
-- Reusable blueprints that pre-fill the task create form

CREATE TABLE IF NOT EXISTS task_templates (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  title        TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 500),
  description  TEXT,
  priority     TEXT        NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  checklist    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_templates_workspace_id_idx ON task_templates(workspace_id);
