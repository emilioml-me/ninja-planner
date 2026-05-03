import { pool } from '../config/db.js';

export interface Goal {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface GoalWithProgress extends Goal {
  total_tasks: number;
  done_tasks: number;
}

export interface GoalLink {
  id: string;
  goal_id: string;
  entity_type: string;
  entity_id: string;
  created_at: Date;
}

export async function getGoals(workspaceId: string): Promise<GoalWithProgress[]> {
  const result = await pool.query<GoalWithProgress>(
    `SELECT
       g.*,
       COUNT(gl.id) FILTER (WHERE gl.entity_type = 'task')::int                                     AS total_tasks,
       COUNT(t.id)  FILTER (WHERE gl.entity_type = 'task' AND t.status = 'done' AND t.deleted_at IS NULL)::int AS done_tasks
     FROM goals g
     LEFT JOIN goal_links gl ON gl.goal_id = g.id
     LEFT JOIN tasks t ON t.id = gl.entity_id AND gl.entity_type = 'task'
     WHERE g.workspace_id = $1
     GROUP BY g.id
     ORDER BY g.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function createGoal(
  workspaceId: string,
  data: { title: string; description?: string; due_date?: string },
  createdBy: string,
): Promise<Goal> {
  const result = await pool.query<Goal>(
    `INSERT INTO goals (workspace_id, title, description, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workspaceId, data.title, data.description ?? null, data.due_date ?? null, createdBy],
  );
  return result.rows[0];
}

const GOAL_UPDATABLE = new Set(['title', 'description', 'status', 'due_date']);

export async function updateGoal(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Goal, 'title' | 'description' | 'status' | 'due_date'>>,
): Promise<Goal | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && GOAL_UPDATABLE.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;
  values.push(id, workspaceId);
  const result = await pool.query<Goal>(
    `UPDATE goals SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteGoal(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM goals WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── goal links ──────────────────────────���─────────────────────��─────────────

export async function getGoalLinks(goalId: string, workspaceId: string): Promise<GoalLink[]> {
  const result = await pool.query<GoalLink>(
    `SELECT gl.* FROM goal_links gl
     JOIN goals g ON g.id = gl.goal_id
     WHERE gl.goal_id = $1 AND g.workspace_id = $2`,
    [goalId, workspaceId],
  );
  return result.rows;
}

export async function addGoalLink(
  goalId: string,
  workspaceId: string,
  entityType: string,
  entityId: string,
): Promise<GoalLink> {
  // Verify goal belongs to workspace
  const goalCheck = await pool.query(
    'SELECT id FROM goals WHERE id = $1 AND workspace_id = $2',
    [goalId, workspaceId],
  );
  if (goalCheck.rows.length === 0) throw new Error('Goal not found');

  const result = await pool.query<GoalLink>(
    `INSERT INTO goal_links (goal_id, entity_type, entity_id) VALUES ($1, $2, $3)
     ON CONFLICT (goal_id, entity_type, entity_id) DO NOTHING RETURNING *`,
    [goalId, entityType, entityId],
  );
  return result.rows[0];
}

export async function removeGoalLink(
  goalId: string,
  workspaceId: string,
  entityId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM goal_links gl USING goals g
     WHERE gl.goal_id = g.id AND gl.goal_id = $1 AND g.workspace_id = $2 AND gl.entity_id = $3`,
    [goalId, workspaceId, entityId],
  );
  return (result.rowCount ?? 0) > 0;
}
