-- Custom fields: workspace-defined fields attached to tasks
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  field_type   TEXT        NOT NULL CHECK (field_type IN ('text','number','url','date','select')),
  options      TEXT[],
  position     INT         NOT NULL DEFAULT 0,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  field_def_id UUID        NOT NULL REFERENCES custom_field_defs(id) ON DELETE CASCADE,
  task_id      UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  value_text   TEXT,
  value_number NUMERIC,
  value_date   DATE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (field_def_id, task_id)
);

CREATE INDEX IF NOT EXISTS custom_field_defs_workspace_idx   ON custom_field_defs(workspace_id);
CREATE INDEX IF NOT EXISTS custom_field_values_task_idx      ON custom_field_values(task_id);
CREATE INDEX IF NOT EXISTS custom_field_values_def_idx       ON custom_field_values(field_def_id);
