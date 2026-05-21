-- Migration 013: Task dependencies (blocks / blocked-by)
-- blocking_task_id must be completed before blocked_task_id can begin.
-- workspace_id is denormalised for fast tenant-scoped lookups and cascade.

CREATE TABLE IF NOT EXISTS task_dependencies (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  blocking_task_id UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_task_id  UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT task_dependencies_no_self  CHECK (blocking_task_id != blocked_task_id),
  CONSTRAINT task_dependencies_unique   UNIQUE (blocking_task_id, blocked_task_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_blocking_idx ON task_dependencies(blocking_task_id);
CREATE INDEX IF NOT EXISTS task_dependencies_blocked_idx  ON task_dependencies(blocked_task_id);
CREATE INDEX IF NOT EXISTS task_dependencies_workspace_idx ON task_dependencies(workspace_id);
