import { pool } from '../config/db.js';

export interface RoadmapItem {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
  external_ref: string | null;
  created_at: Date;
  updated_at: Date;
  // Computed from roadmap_task_links
  linked_tasks: number;
  linked_done: number;
  // Computed from roadmap_votes — previously only surfaced on the public roadmap
  // (shareService.getPublicRoadmap), leaving admins with no visibility into which
  // items got public traction without opening the separate share link.
  vote_count: number;
}

export async function getRoadmap(
  workspaceId: string,
  filters: { status?: string; phase?: string },
): Promise<RoadmapItem[]> {
  const conditions = ['ri.workspace_id = $1'];
  const values: unknown[] = [workspaceId];
  let i = 2;

  if (filters.status) { conditions.push(`ri.status = $${i++}`); values.push(filters.status); }
  if (filters.phase)  { conditions.push(`ri.phase = $${i++}`);  values.push(filters.phase); }

  const result = await pool.query<RoadmapItem>(
    `SELECT ri.*,
            COALESCE(COUNT(rtl.task_id) FILTER (WHERE t.deleted_at IS NULL), 0)::int             AS linked_tasks,
            COALESCE(COUNT(rtl.task_id) FILTER (WHERE t.status = 'done' AND t.deleted_at IS NULL), 0)::int AS linked_done,
            COALESCE(v.cnt, 0)::int AS vote_count
     FROM roadmap_items ri
     LEFT JOIN roadmap_task_links rtl ON rtl.roadmap_item_id = ri.id
     LEFT JOIN tasks t ON t.id = rtl.task_id AND t.workspace_id = $1
     LEFT JOIN (
       -- Scoped to this workspace's items so the aggregate doesn't scan every tenant's votes.
       SELECT rv.roadmap_item_id, COUNT(*) AS cnt
       FROM roadmap_votes rv
       JOIN roadmap_items r2 ON r2.id = rv.roadmap_item_id AND r2.workspace_id = $1
       GROUP BY rv.roadmap_item_id
     ) v ON v.roadmap_item_id = ri.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY ri.id, v.cnt
     ORDER BY ri.priority, ri.created_at
     LIMIT 1000`,
    values,
  );
  return result.rows;
}

export async function createRoadmapItem(
  workspaceId: string,
  data: {
    title: string;
    description?: string | null;
    phase?: string | null;
    status?: string;
    priority?: number;
    external_ref?: string | null;
  },
): Promise<RoadmapItem> {
  const result = await pool.query<RoadmapItem>(
    `INSERT INTO roadmap_items (workspace_id, title, description, phase, status, priority, external_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      data.title,
      data.description ?? null,
      data.phase ?? null,
      data.status ?? 'idea',
      data.priority ?? 0,
      data.external_ref ?? null,
    ],
  );
  return result.rows[0];
}

const ROADMAP_UPDATABLE_COLUMNS = new Set(['title', 'description', 'phase', 'status', 'priority', 'external_ref']);

/**
 * Also returns the item's status immediately before this update (`prev_status`, read under a
 * row lock in the same statement) so callers can fire side effects only on a real transition.
 */
export async function updateRoadmapItem(
  id: string,
  workspaceId: string,
  data: Partial<Pick<RoadmapItem, 'title' | 'description' | 'phase' | 'status' | 'priority' | 'external_ref'>>,
): Promise<(RoadmapItem & { prev_status: string }) | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && ROADMAP_UPDATABLE_COLUMNS.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<RoadmapItem & { prev_status: string }>(
    `WITH prev AS (
       SELECT id, status FROM roadmap_items WHERE id = $${i++} AND workspace_id = $${i} FOR UPDATE
     )
     UPDATE roadmap_items ri SET ${fields.join(', ')}
     FROM prev
     WHERE ri.id = prev.id
     RETURNING ri.*, prev.status AS prev_status`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteRoadmapItem(id: string, workspaceId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'DELETE FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
      [id, workspaceId],
    );
    // goal_links is polymorphic (entity_type: 'task' | 'roadmap_item') so it has no FK to
    // roadmap_items — deleting the item without this left a permanent orphaned link row,
    // returned forever by GET /api/goals/:id/links and rendered as a dead link by any consumer.
    if ((result.rowCount ?? 0) > 0) {
      await client.query(
        `DELETE FROM goal_links WHERE entity_type = 'roadmap_item' AND entity_id = $1 AND workspace_id = $2`,
        [id, workspaceId],
      );
    }
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
