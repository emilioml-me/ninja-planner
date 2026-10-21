-- 063: CHECK constraints on enum-like TEXT/varchar columns (review L76).
-- Values mirror the zod enums in the routes (tasks.ts TASK_STATUSES/TASK_PRIORITIES,
-- sprints.ts SPRINT_STATUSES, goals.ts, roadmap.ts STATUSES, clients.ts STAGES) and
-- notificationService.NOTIFICATION_TYPES. Added NOT VALID: enforced for every new/updated row
-- without scanning (or failing on) legacy rows; run ALTER TABLE ... VALIDATE CONSTRAINT later
-- once existing data has been checked. Any new value added to one of those enums needs a
-- migration that drops and re-adds the matching constraint.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('tasks',         'tasks_status_check',
        $c$status IN ('todo', 'in_progress', 'done', 'blocked')$c$),
      ('tasks',         'tasks_priority_check',
        $c$priority IN ('low', 'medium', 'high', 'urgent')$c$),
      ('sprints',       'sprints_status_check',
        $c$status IN ('planning', 'active', 'completed')$c$),
      ('goals',         'goals_status_check',
        $c$status IN ('active', 'completed', 'cancelled')$c$),
      ('roadmap_items', 'roadmap_items_status_check',
        $c$status IN ('idea', 'building', 'live', 'archived')$c$),
      ('clients',       'clients_stage_check',
        $c$stage IN ('prospect', 'proposal', 'active', 'churned')$c$),
      ('notifications', 'notifications_type_check',
        $c$type IN ('comment_added', 'mention', 'review_submitted', 'overdue_alert',
                    'task_assigned', 'due_date_set', 'task_updated', 'goal_milestone',
                    'sprint_ending', 'automation')$c$)
    ) AS v(tbl, conname, expr)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass(r.tbl) AND conname = r.conname
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', r.tbl, r.conname, r.expr);
    END IF;
  END LOOP;
END $$;
