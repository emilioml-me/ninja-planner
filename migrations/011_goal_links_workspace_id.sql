-- Migration 011: add workspace_id to goal_links for defence-in-depth tenant isolation
-- Previously isolation was enforced by joining through the goals table.
-- Adding the column here makes it directly queryable and adds a FK cascade.

ALTER TABLE goal_links
  ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- Back-fill from the parent goal
UPDATE goal_links gl
SET workspace_id = g.workspace_id
FROM goals g
WHERE gl.goal_id = g.id
  AND gl.workspace_id IS NULL;

-- Make non-nullable now that all rows are filled
ALTER TABLE goal_links
  ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS goal_links_workspace_idx ON goal_links(workspace_id);
