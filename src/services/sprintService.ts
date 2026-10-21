import { pool } from '../config/db.js';
import type { Task } from './taskService.js';

export interface Sprint {
  id: string;
  workspace_id: string;
  name: string;
  goal: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  /** NUMERIC -> string on the wire; null until the sprint is first activated (migration 060). */
  committed_points?: string | null;
  committed_task_count?: number | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface SprintWithStats extends Sprint {
  total_tasks: number;
  done_tasks: number;
}

export async function getSprints(workspaceId: string, limit = 200): Promise<SprintWithStats[]> {
  const result = await pool.query<SprintWithStats>(
    `SELECT
       s.*,
       COUNT(t.id)::int                                             AS total_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'done')::int           AS done_tasks
     FROM sprints s
     LEFT JOIN tasks t ON t.sprint_id = s.id AND t.deleted_at IS NULL
     WHERE s.workspace_id = $1
     GROUP BY s.id
     ORDER BY
       CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,
       s.start_date DESC NULLS LAST
     LIMIT $2`,
    [workspaceId, limit],
  );
  return result.rows;
}

export async function getSprintById(id: string, workspaceId: string): Promise<Sprint | null> {
  const result = await pool.query<Sprint>(
    'SELECT * FROM sprints WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function createSprint(
  workspaceId: string,
  data: { name: string; goal?: string | null; status?: string; start_date?: string | null; end_date?: string | null },
  createdBy: string,
): Promise<Sprint> {
  const result = await pool.query<Sprint>(
    `INSERT INTO sprints (workspace_id, name, goal, status, start_date, end_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      workspaceId,
      data.name,
      data.goal ?? null,
      data.status ?? 'planning',
      data.start_date ?? null,
      data.end_date ?? null,
      createdBy,
    ],
  );
  return result.rows[0];
}

const SPRINT_UPDATABLE = new Set(['name', 'goal', 'status', 'start_date', 'end_date']);

/**
 * Updates a sprint and also returns the status it had immediately before this update
 * (`prev_status`), read under a row lock in the same statement. Callers use it to fire
 * transition side effects (quest creation, sprint.completed automations/webhooks) only when the
 * status actually changes — not on every save whose payload happens to repeat the status.
 * `null` values clear nullable columns; `undefined` leaves them untouched.
 */
export async function updateSprint(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Sprint, 'name' | 'goal' | 'status' | 'start_date' | 'end_date'>>,
): Promise<(Sprint & { prev_status: string }) | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && SPRINT_UPDATABLE.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;
  values.push(id, workspaceId);
  const result = await pool.query<Sprint & { prev_status: string }>(
    `WITH prev AS (
       SELECT id, status FROM sprints WHERE id = $${i++} AND workspace_id = $${i} FOR UPDATE
     )
     UPDATE sprints s SET ${fields.join(', ')}
     FROM prev
     WHERE s.id = prev.id
     RETURNING s.*, prev.status AS prev_status`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * Snapshots the sprint's committed scope (story points + task count of its current, non-deleted
 * tasks) into sprints.committed_points / committed_task_count (migration 060). Called when a
 * sprint becomes active (overwrite) and, if still unset, when it completes and before
 * move-to-backlog strips unfinished tasks — so velocity's "committed" figure isn't just the work
 * that happened to remain in the sprint.
 */
export async function snapshotSprintCommitment(
  sprintId: string,
  workspaceId: string,
  opts: { onlyIfUnset: boolean },
): Promise<void> {
  await pool.query(
    `UPDATE sprints s SET
       committed_points     = c.points,
       committed_task_count = c.task_count
     FROM (
       SELECT COALESCE(SUM(t.story_points), 0) AS points, COUNT(t.id)::int AS task_count
       FROM tasks t
       WHERE t.sprint_id = $1 AND t.workspace_id = $2 AND t.deleted_at IS NULL
     ) c
     WHERE s.id = $1 AND s.workspace_id = $2
       AND (NOT $3::boolean OR s.committed_points IS NULL)`,
    [sprintId, workspaceId, opts.onlyIfUnset],
  );
}

export async function deleteSprint(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM sprints WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getSprintTasks(sprintId: string, workspaceId: string): Promise<Task[]> {
  const result = await pool.query<Task>(
    `SELECT t.* FROM tasks t
     JOIN sprints s ON s.id = t.sprint_id
     WHERE t.sprint_id = $1 AND s.workspace_id = $2 AND t.deleted_at IS NULL
     ORDER BY t.position, t.created_at
     LIMIT 2000`,
    [sprintId, workspaceId],
  );
  return result.rows;
}
