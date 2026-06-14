// GET /public/g/:token — unauthenticated guest view
import { Router } from 'express';
import { pool } from '../config/db.js';

const router = Router();

async function resolveShare(token: string) {
  const { rows } = await pool.query(
    `SELECT * FROM project_shares
     WHERE token = $1
       AND (expires_at IS NULL OR expires_at > now())`,
    [token],
  );
  return rows[0] ?? null;
}

router.get('/:token', async (req, res, next) => {
  try {
    const share = await resolveShare(req.params.token);
    if (!share) { res.status(404).json({ error: 'Link not found or expired' }); return; }

    const scopes: string[] = share.scopes;
    const wid = share.workspace_id;
    const result: Record<string, unknown> = {
      workspace_id: wid,
      label: share.label,
      scopes,
    };

    await Promise.all([
      scopes.includes('tasks:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, status, priority, due_date, tags, assignee_clerk_id
           FROM tasks WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY position, created_at`,
          [wid],
        );
        result.tasks = rows;
      })(),
      scopes.includes('roadmap:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, description, phase, status, priority
           FROM roadmap_items WHERE workspace_id = $1 ORDER BY priority, created_at`,
          [wid],
        );
        result.roadmap = rows;
      })(),
      scopes.includes('goals:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, status, due_date FROM goals WHERE workspace_id = $1 ORDER BY created_at`,
          [wid],
        );
        result.goals = rows;
      })(),
      scopes.includes('sprints:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, name, status, start_date, end_date, goal
           FROM sprints WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`,
          [wid],
        );
        result.sprints = rows;
      })(),
    ]);

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
