-- 065: confirm task.due_date_passed dispatches (review M40).
-- due_date_passed_notified_at (037) is stamped when the sweep claims a task, before the
-- automations run; a restart mid-dispatch used to lose those automations permanently.
-- due_date_passed_dispatched_at is set once dispatch finished; a claim that stays unconfirmed
-- (dispatched_at NULL or older than notified_at) past a grace period is re-claimed.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_date_passed_dispatched_at TIMESTAMPTZ;

-- Everything claimed before this column existed was dispatched by the old code path (or lost
-- long ago); mark it confirmed so the first sweep doesn't re-fire historic overdue tasks.
UPDATE tasks
SET due_date_passed_dispatched_at = due_date_passed_notified_at
WHERE due_date_passed_notified_at IS NOT NULL
  AND due_date_passed_dispatched_at IS NULL;
