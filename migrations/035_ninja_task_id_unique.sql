BEGIN;
-- Prevents two tasks (in any workspace) from ever sharing the same external_ninja_task_id.
-- The inbound ninja-task webhook (POST /api/integrations/ninja-task/webhook) matches purely on
-- external_ninja_task_id with no workspace_id filter, since ninja-task's webhook payload has no
-- workspace context to filter on. Without this constraint, a collision would let one HMAC-valid
-- webhook call flip a task's status in the wrong workspace. With it, the column is guaranteed
-- 1:1 with a single task, so the existing WHERE clause is safe.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_ninja_task_id_unique
  ON tasks (external_ninja_task_id)
  WHERE external_ninja_task_id IS NOT NULL;
COMMIT;
