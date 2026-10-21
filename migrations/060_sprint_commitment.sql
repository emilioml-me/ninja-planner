-- 060: snapshot of a sprint's commitment (review M19).
-- Velocity/"committed" was computed from the tasks still in the sprint, and completing a sprint
-- moves unfinished tasks to the backlog, so every closed sprint showed 100% delivery.
-- sprintService records these when the sprint goes active (and, if still NULL, when it
-- completes, before unfinished tasks are moved out). NULL = no snapshot (legacy sprints);
-- analytics falls back to the current calculation.
ALTER TABLE sprints
  ADD COLUMN IF NOT EXISTS committed_points     NUMERIC,
  ADD COLUMN IF NOT EXISTS committed_task_count INTEGER;
