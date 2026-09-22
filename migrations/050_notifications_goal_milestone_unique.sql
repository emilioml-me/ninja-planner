-- Backs the goal-milestone notification dedup guard in goalService.ts with a real unique
-- constraint. Previously that guard was an INSERT ... WHERE NOT EXISTS with nothing enforcing
-- uniqueness at the DB level, so two concurrent requests (e.g. two sibling tasks under the same
-- goal completing close together) could both pass the NOT EXISTS check before either commit,
-- producing duplicate notifications and duplicate milestone emails.

-- Drop any duplicate goal_milestone rows first so the unique index can be created.
DELETE FROM notifications a
USING notifications b
WHERE a.type = 'goal_milestone'
  AND b.type = 'goal_milestone'
  AND a.workspace_id = b.workspace_id
  AND a.recipient_clerk_id = b.recipient_clerk_id
  AND a.body = b.body
  AND a.id > b.id;

CREATE UNIQUE INDEX idx_notifications_goal_milestone_dedup
  ON notifications (workspace_id, recipient_clerk_id, body)
  WHERE type = 'goal_milestone';
