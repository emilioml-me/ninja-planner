-- Migration 005: roadmap_task_links
-- Associates roadmap items with tasks to track execution progress

CREATE TABLE IF NOT EXISTS roadmap_task_links (
  roadmap_item_id UUID        NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  task_id         UUID        NOT NULL REFERENCES tasks(id)         ON DELETE CASCADE,
  workspace_id    UUID        NOT NULL REFERENCES workspaces(id)    ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (roadmap_item_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_roadmap_task_links_item ON roadmap_task_links(roadmap_item_id);
CREATE INDEX IF NOT EXISTS idx_roadmap_task_links_task ON roadmap_task_links(task_id);
