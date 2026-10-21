-- 059: move goal-milestone notification dedup from `body` to `dedup_key` (review M18).
-- goalService stored '<goalId>:<50|100>' in body purely for dedup (backed by 050's unique index
-- on (workspace_id, recipient_clerk_id, body) WHERE type = 'goal_milestone'), so the bell showed
-- raw '<uuid>:100' text. Milestone inserts now use dedup_key = 'goal_milestone:<goalId>:<50|100>'
-- with ON CONFLICT on 052's idx_notifications_dedup_key, and a human-readable body.
-- Runs inside the migration runner's own transaction (no BEGIN/COMMIT here).

-- The 050 index must go first: once bodies are readable text, several milestones for one
-- recipient legitimately share the same body.
DROP INDEX IF EXISTS idx_notifications_goal_milestone_dedup;

-- Backfill dedup_key from the legacy body (skipping any key that somehow already exists, so the
-- 052 unique index can't be violated) and replace the body with readable text.
UPDATE notifications n
SET dedup_key = 'goal_milestone:' || n.body,
    body = CASE
      WHEN n.body LIKE '%:100' THEN 'All linked work for this goal is done.'
      ELSE 'Half of the linked work for this goal is done.'
    END
WHERE n.type = 'goal_milestone'
  AND n.dedup_key IS NULL
  AND n.body ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(50|100)$'
  AND NOT EXISTS (
    SELECT 1 FROM notifications x
    WHERE x.workspace_id = n.workspace_id
      AND x.recipient_clerk_id = n.recipient_clerk_id
      AND x.dedup_key = 'goal_milestone:' || n.body
  );

-- 052 already created this; repeated here so the ON CONFLICT target is guaranteed to exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_key
  ON notifications (workspace_id, recipient_clerk_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
