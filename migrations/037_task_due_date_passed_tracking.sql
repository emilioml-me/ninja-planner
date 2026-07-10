BEGIN;
-- Tracks whether the task.due_date_passed automation trigger has already fired for this task,
-- so the periodic due-date-check endpoint below can dispatch each overdue task exactly once
-- instead of re-firing every time the check runs while the task remains overdue.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date_passed_notified_at TIMESTAMPTZ;
COMMIT;
