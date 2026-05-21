import { pool } from '../config/db.js';

export interface Epic {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  color: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface EpicWithStats extends Epic {
  total_tasks: number;
  done_tasks: number;
  total_points: number;
  done_points: number;
}

export async function getEpics(workspaceId: string): Promise<EpicWithStats[]> {
  const result = await pool.query<EpicWithStats>(
    `SELECT
       e.*,
       COUNT(t.id)::int                                                   AS total_tasks,
       COUNT(t.id) FILTER (WHERE t.status = 'done')::int                  AS done_tasks,
       COALESCE(SUM(t.story_points), 0)::int                              AS total_points,
       COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'done'), 0)::int AS done_points
     FROM epics e
     LEFT JOIN tasks t ON t.epic_id = e.id AND t.deleted_at IS NULL
     WHERE e.workspace_id = $1
     GROUP BY e.id
     ORDER BY
       CASE e.status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
       e.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function getEpicById(id: string, workspaceId: string): Promise<Epic | null> {
  const result = await pool.query<Epic>(
    'SELECT * FROM epics WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function createEpic(
  workspaceId: string,
  data: { title: string; description?: string; status?: string; color?: string },
  createdBy: string,
): Promise<Epic> {
  const result = await pool.query<Epic>(
    `INSERT INTO epics (workspace_id, title, description, status, color, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      workspaceId,
      data.title,
      data.description ?? null,
      data.status ?? 'active',
      data.color ?? '#6366f1',
      createdBy,
    ],
  );
  return result.rows[0];
}

const EPIC_UPDATABLE = new Set(['title', 'description', 'status', 'color']);

export async function updateEpic(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Epic, 'title' | 'description' | 'status' | 'color'>>,
): Promise<Epic | null> {
  const fields: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && EPIC_UPDATABLE.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  values.push(id, workspaceId);
  const result = await pool.query<Epic>(
    `UPDATE epics SET ${fields.join(', ')}
     WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteEpic(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM epics WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
