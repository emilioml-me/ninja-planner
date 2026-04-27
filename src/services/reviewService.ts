import { pool } from '../config/db.js';

export interface WeeklyReview {
  id: string;
  workspace_id: string;
  week_start: string;
  wins: string | null;
  blockers: string | null;
  focus_next: string | null;
  health_score: number | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export async function getReviews(workspaceId: string): Promise<WeeklyReview[]> {
  const result = await pool.query<WeeklyReview>(
    'SELECT * FROM weekly_reviews WHERE workspace_id = $1 ORDER BY week_start DESC',
    [workspaceId],
  );
  return result.rows;
}

export async function createReview(
  workspaceId: string,
  data: {
    week_start: string;
    wins?: string;
    blockers?: string;
    focus_next?: string;
    health_score?: number;
  },
  createdBy: string,
): Promise<WeeklyReview> {
  const result = await pool.query<WeeklyReview>(
    `INSERT INTO weekly_reviews (workspace_id, week_start, wins, blockers, focus_next, health_score, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      data.week_start,
      data.wins ?? null,
      data.blockers ?? null,
      data.focus_next ?? null,
      data.health_score ?? null,
      createdBy,
    ],
  );
  return result.rows[0];
}

export async function getReviewById(id: string, workspaceId: string): Promise<WeeklyReview | null> {
  const result = await pool.query<WeeklyReview>(
    'SELECT * FROM weekly_reviews WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

const REVIEW_UPDATABLE_COLUMNS = new Set(['wins', 'blockers', 'focus_next', 'health_score']);

export async function updateReview(
  id: string,
  workspaceId: string,
  data: Partial<Pick<WeeklyReview, 'wins' | 'blockers' | 'focus_next' | 'health_score'>>,
): Promise<WeeklyReview | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && REVIEW_UPDATABLE_COLUMNS.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<WeeklyReview>(
    `UPDATE weekly_reviews SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}
