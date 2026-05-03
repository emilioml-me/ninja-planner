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
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface SprintWithStats extends Sprint {
  total_tasks: number;
  done_tasks: number;
}

export async function getSprints(workspaceId: string): Promise<SprintWithStats[]> {
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
       s.start_date DESC NULLS LAST`,
    [workspaceId],
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
  data: { name: string; goal?: string; status?: string; start_date?: string; end_date?: string },
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

export async function updateSprint(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Sprint, 'name' | 'goal' | 'status' | 'start_date' | 'end_date'>>,
): Promise<Sprint | null> {
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
  const result = await pool.query<Sprint>(
    `UPDATE sprints SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
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
     ORDER BY t.position, t.created_at`,
    [sprintId, workspaceId],
  );
  return result.rows;
}
