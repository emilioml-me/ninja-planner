-- 052: fixes backing the sprint/review/notification review findings (H2a, M15, M50).
-- Runs inside the migration runner's own transaction (no BEGIN/COMMIT here).

-- ─── sprint_quests: one quest per (sprint, member) ──────────────────────────────
-- Quest creation used to fire on every PATCH that carried status='active' (not only on the
-- planning->active transition), so a member could accumulate several quests for one sprint.
-- Keep one row per (sprint_id, clerk_user_id) — preferring a completed quest, then the oldest —
-- before adding the unique index the insert's ON CONFLICT relies on.
DELETE FROM sprint_quests sq
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY sprint_id, clerk_user_id
           ORDER BY (completed_at IS NULL), created_at, id
         ) AS rn
  FROM sprint_quests
) ranked
WHERE sq.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS sprint_quests_sprint_member_unique
  ON sprint_quests (sprint_id, clerk_user_id);

-- ─── weekly_reviews: one review per member per week ─────────────────────────────
-- Reviews are personal (the UI lets every member write their own), but 001_init.sql made them
-- unique per workspace per week, so the second member to submit got a 409. The old constraint
-- is strictly narrower than the new one, so existing data can't violate the new index.
ALTER TABLE weekly_reviews DROP CONSTRAINT IF EXISTS weekly_reviews_workspace_id_week_start_key;

CREATE UNIQUE INDEX IF NOT EXISTS weekly_reviews_workspace_week_author_unique
  ON weekly_reviews (workspace_id, week_start, created_by);

-- ─── notifications: dedicated dedup key ─────────────────────────────────────────
-- sprint_ending notifications used the sprint UUID as `body` purely for dedup, which then
-- rendered as a raw UUID in the user's notification list. dedup_key carries that identity
-- instead, backed by a real unique index so concurrent inserts can't double-notify.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedup_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup_key
  ON notifications (workspace_id, recipient_clerk_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

-- Clear the raw-UUID bodies already stored on legacy sprint_ending rows.
UPDATE notifications
SET body = NULL
WHERE type = 'sprint_ending'
  AND body ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
