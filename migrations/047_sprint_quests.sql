-- Sprint -> Quest sync creates one ninja-task quest PER workspace member (not one per sprint),
-- so the single sprints.ninja_task_quest_id column added in 034 could never represent all of
-- them — it was left unwritten. This table tracks every member's quest for a sprint, which the
-- quest_complete webhook needs to map an incoming questId back to (sprint, member).
BEGIN;

CREATE TABLE IF NOT EXISTS sprint_quests (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sprint_id           UUID        NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
  workspace_id        UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  clerk_user_id       TEXT        NOT NULL,
  ninja_task_quest_id TEXT        NOT NULL,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sprint_quests_quest_id_unique ON sprint_quests(ninja_task_quest_id);
CREATE INDEX IF NOT EXISTS sprint_quests_sprint_idx ON sprint_quests(sprint_id);

COMMIT;
