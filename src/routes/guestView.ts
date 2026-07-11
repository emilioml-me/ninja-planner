// GET /public/g/:token — unauthenticated guest view
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../config/db.js';

const router = Router();

// Unauthenticated, token-gated, and can leak tasks/roadmap/goals/sprints/epics/changelog/budget
// data on a successful token guess — tighter than the global 200/min limiter, matching the same
// intent as share.ts's voteLimiter and invites.ts's inviteLookupLimiter (both exist specifically
// to slow down token-guessing against similar public endpoints).
const guestViewLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

async function resolveShare(token: string) {
  const { rows } = await pool.query(
    `SELECT * FROM project_shares
     WHERE token = $1
       AND (expires_at IS NULL OR expires_at > now())`,
    [token],
  );
  return rows[0] ?? null;
}

router.get('/:token', guestViewLimiter, async (req, res, next) => {
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
      // Reuses the same rollup stats getEpics() computes for the internal Epics page —
      // clients/stakeholders can see initiative-level progress without a separate share system.
      scopes.includes('epics:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT
             e.id, e.title, e.description, e.status, e.color,
             COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL)::int AS total_tasks,
             COUNT(t.id) FILTER (WHERE t.status = 'done' AND t.deleted_at IS NULL)::int AS done_tasks
           FROM epics e
           LEFT JOIN tasks t ON t.epic_id = e.id
           WHERE e.workspace_id = $1 AND e.status != 'archived'
           GROUP BY e.id
           ORDER BY e.created_at DESC`,
          [wid],
        );
        result.epics = rows;
      })(),
      // Mirrors changelog.ts's own query (last 30 days, task-level detail) minus admin-only
      // fields — clients on a shared link get the same "what shipped" view as workspace members.
      scopes.includes('changelog:read') && (async () => {
        const { rows } = await pool.query(
          `WITH done_times AS (
             SELECT DISTINCT ON (ta.task_id)
               ta.task_id,
               ta.created_at AS completed_at
             FROM task_activity ta
             JOIN tasks t ON t.id = ta.task_id
             WHERE t.workspace_id = $1
               AND t.status = 'done'
               AND ta.action IN ('updated', 'created')
               AND (ta.payload->>'status') = 'done'
               AND t.deleted_at IS NULL
             ORDER BY ta.task_id, ta.created_at DESC
           )
           SELECT t.id, t.title, t.priority, dt.completed_at,
                  sp.name AS sprint_name, e.title AS epic_title
           FROM done_times dt
           JOIN tasks t ON t.id = dt.task_id
           LEFT JOIN sprints sp ON sp.id = t.sprint_id
           LEFT JOIN epics   e  ON e.id  = t.epic_id
           WHERE t.workspace_id = $1
             AND dt.completed_at >= now() - interval '30 days'
           ORDER BY dt.completed_at DESC
           LIMIT 100`,
          [wid],
        );
        result.changelog = rows;
      })(),
      // Rollup-only (name/target/actual) — never expose individual entry descriptions or who
      // logged them, since guest links are meant for external stakeholders, not internal spend detail.
      scopes.includes('budgets:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT b.id, b.name, b.target_amount, b.currency, b.period_start, b.period_end, b.status,
                  COALESCE(SUM(be.amount), 0)::numeric AS actual_amount
           FROM budgets b
           LEFT JOIN budget_entries be ON be.budget_id = b.id
           WHERE b.workspace_id = $1
           GROUP BY b.id
           ORDER BY b.created_at DESC`,
          [wid],
        );
        result.budgets = rows;
      })(),
    ]);

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
