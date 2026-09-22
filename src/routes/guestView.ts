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
    // Only fields GuestView.tsx actually renders are returned — internal identifiers (workspace
    // id, assignee Clerk ids), tags, and free-text descriptions/goals aren't meant for external
    // stakeholders on a share link.
    const result: Record<string, unknown> = {
      label: share.label,
      scopes,
    };

    await Promise.all([
      scopes.includes('tasks:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, status, priority, due_date
           FROM tasks WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY position, created_at LIMIT 500`,
          [wid],
        );
        result.tasks = rows;
      })(),
      scopes.includes('roadmap:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, phase, status, priority
           FROM roadmap_items WHERE workspace_id = $1 ORDER BY priority, created_at LIMIT 200`,
          [wid],
        );
        result.roadmap = rows;
      })(),
      scopes.includes('goals:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, title, status, due_date FROM goals WHERE workspace_id = $1 ORDER BY created_at LIMIT 200`,
          [wid],
        );
        result.goals = rows;
      })(),
      scopes.includes('sprints:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT id, name, status, start_date, end_date
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
             e.id, e.title, e.status, e.color,
             COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL)::int AS total_tasks,
             COUNT(t.id) FILTER (WHERE t.status = 'done' AND t.deleted_at IS NULL)::int AS done_tasks
           FROM epics e
           LEFT JOIN tasks t ON t.epic_id = e.id
           WHERE e.workspace_id = $1 AND e.status != 'archived'
           GROUP BY e.id
           ORDER BY e.created_at DESC LIMIT 200`,
          [wid],
        );
        result.epics = rows;
      })(),
      // Mirrors changelog.ts's own query (last 30 days, task-level detail) minus admin-only
      // fields — clients on a shared link get the same "what shipped" view as workspace members.
      scopes.includes('changelog:read') && (async () => {
        const { rows } = await pool.query(
          // Same completion-time rule as changelog.ts: first status='done' row after the last
          // non-done status row ('moved' included for historical Kanban-drag rows).
          `WITH status_rows AS (
             SELECT ta.task_id, ta.created_at, ta.payload->>'status' AS status
             FROM task_activity ta
             JOIN tasks t ON t.id = ta.task_id
             WHERE t.workspace_id = $1
               AND t.status = 'done'
               AND t.deleted_at IS NULL
               AND ta.action IN ('updated', 'created', 'moved')
               AND (ta.payload->>'status') IS NOT NULL
           ),
           last_reopen AS (
             SELECT task_id, MAX(created_at) AS reopened_at
             FROM status_rows
             WHERE status <> 'done'
             GROUP BY task_id
           ),
           done_times AS (
             SELECT sr.task_id, MIN(sr.created_at) AS completed_at
             FROM status_rows sr
             LEFT JOIN last_reopen lr ON lr.task_id = sr.task_id
             WHERE sr.status = 'done'
               AND (lr.reopened_at IS NULL OR sr.created_at > lr.reopened_at)
             GROUP BY sr.task_id
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
      // Rollup-only (name/target/actual/time_cost) — never expose individual entry descriptions or
      // who logged them, since guest links are meant for external stakeholders, not internal spend
      // detail. time_cost mirrors the internal Budgets page (budgets.ts GET /): billable logged
      // time on the linked epic's/sprint's tasks, reported separately from manual entries.
      scopes.includes('budgets:read') && (async () => {
        const { rows } = await pool.query(
          `SELECT b.id, b.name, b.target_amount, b.currency, b.period_start, b.period_end, b.status,
                  COALESCE(be_agg.actual_amount, 0)::numeric AS actual_amount,
                  COALESCE(tc.time_cost, 0)::numeric         AS time_cost
           FROM budgets b
           LEFT JOIN (
             SELECT budget_id, SUM(amount) AS actual_amount
             FROM budget_entries
             WHERE workspace_id = $1
             GROUP BY budget_id
           ) be_agg ON be_agg.budget_id = b.id
           LEFT JOIN LATERAL (
             SELECT SUM((tl.minutes / 60.0) * tl.hourly_rate) AS time_cost
             FROM time_logs tl
             JOIN tasks t ON t.id = tl.task_id
             WHERE t.workspace_id = b.workspace_id
               AND tl.billable = true
               AND tl.hourly_rate IS NOT NULL
               AND ((b.epic_id IS NOT NULL AND t.epic_id = b.epic_id)
                 OR (b.sprint_id IS NOT NULL AND t.sprint_id = b.sprint_id))
           ) tc ON (b.epic_id IS NOT NULL OR b.sprint_id IS NOT NULL)
           WHERE b.workspace_id = $1
           ORDER BY b.created_at DESC LIMIT 200`,
          [wid],
        );
        result.budgets = rows;
      })(),
    ]);

    res.json(result);
  } catch (err) { next(err); }
});

export default router;
