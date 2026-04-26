import { pool } from '../config/db.js';

export interface RoadmapItem {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export async function getRoadmap(
  workspaceId: string,
  filters: { status?: string; phase?: string },
): Promise<RoadmapItem[]> {
  const conditions = ['workspace_id = $1'];
  const values: unknown[] = [workspaceId];
  let i = 2;

  if (filters.status) { conditions.push(`status = $${i++}`); values.push(filters.status); }
  if (filters.phase)  { conditions.push(`phase = $${i++}`);  values.push(filters.phase); }

  const result = await pool.query<RoadmapItem>(
    `SELECT * FROM roadmap_items WHERE ${conditions.join(' AND ')} ORDER BY priority, created_at`,
    values,
  );
  return result.rows;
}

export async function createRoadmapItem(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    phase?: string;
    status?: string;
    priority?: number;
  },
): Promise<RoadmapItem> {
  const result = await pool.query<RoadmapItem>(
    `INSERT INTO roadmap_items (workspace_id, title, description, phase, status, priority)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      workspaceId,
      data.title,
      data.description ?? null,
      data.phase ?? null,
      data.status ?? 'idea',
      data.priority ?? 0,
    ],
  );
  return result.rows[0];
}

export async function updateRoadmapItem(
  id: string,
  workspaceId: string,
  data: Partial<Pick<RoadmapItem, 'title' | 'description' | 'phase' | 'status' | 'priority'>>,
): Promise<RoadmapItem | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<RoadmapItem>(
    `UPDATE roadmap_items SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteRoadmapItem(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
