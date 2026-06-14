// GET /api/analytics/velocity   — sprint velocity (last 12 completed sprints)
// GET /api/analytics/time-report — time-log aggregation with filters
// GET /api/analytics/okr         — OKR roll-up with computed progress
import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

// ── Velocity ──────────────────────────────────────────────────────────────────

router.get('/velocity', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.start_date,
         s.end_date,
         COALESCE(SUM(t.story_points), 0)::int                                                  AS total_points,
         COALESCE(SUM(t.story_points) FILTER (WHERE t.status = 'done'), 0)::int                 AS completed_points,
         COUNT(t.id) FILTER (WHERE t.story_points IS NOT NULL)::int                             AS total_tasks,
         COUNT(t.id) FILTER (WHERE t.story_points IS NOT NULL AND t.status = 'done')::int       AS completed_tasks
       FROM sprints s
       LEFT JOIN tasks t ON t.sprint_id = s.id AND t.deleted_at IS NULL
       WHERE s.workspace_id = $1 AND s.status = 'completed'
       GROUP BY s.id, s.name, s.start_date, s.end_date
       ORDER BY s.end_date DESC NULLS LAST
       LIMIT 12`,
      [req.workspace.id],
    );
    res.json(rows.reverse());
  } catch (err) { next(err); }
});

// ── Time report ───────────────────────────────────────────────────────────────

router.get('/time-report', async (req, res, next) => {
  try {
    const { member, sprint_id, from, to } = req.query as Record<string, string | undefined>;

    const conditions: string[] = ['tl.workspace_id = $1'];
    const values: unknown[] = [req.workspace.id];
    let i = 2;

    if (member)    { conditions.push(`tl.user_clerk_id = $${i++}`); values.push(member); }
    if (sprint_id) { conditions.push(`t.sprint_id = $${i++}`);      values.push(sprint_id); }
    if (from)      { conditions.push(`tl.logged_at::date >= $${i++}`); values.push(from); }
    if (to)        { conditions.push(`tl.logged_at::date <= $${i++}`); values.push(to); }

    const { rows } = await pool.query(
      `SELECT
         tl.id,
         tl.minutes,
         tl.note,
         tl.billable,
         tl.hourly_rate,
         tl.logged_at,
         tl.user_clerk_id,
         t.id   AS task_id,
         t.title AS task_title,
         t.sprint_id,
         s.name  AS sprint_name
       FROM time_logs tl
       JOIN tasks     t ON t.id = tl.task_id
       LEFT JOIN sprints s ON s.id = t.sprint_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY tl.logged_at DESC
       LIMIT 1000`,
      values,
    );

    const totalMinutes  = rows.reduce((s, r) => s + r.minutes, 0);
    const billableMinutes = rows.filter((r) => r.billable).reduce((s, r) => s + r.minutes, 0);
    const billableValue = rows
      .filter((r) => r.billable && r.hourly_rate)
      .reduce((s, r) => s + (r.minutes / 60) * Number(r.hourly_rate), 0);

    res.json({
      rows,
      summary: {
        total_minutes: totalMinutes,
        billable_minutes: billableMinutes,
        billable_value: Math.round(billableValue * 100) / 100,
      },
    });
  } catch (err) { next(err); }
});

// ── OKR dashboard ─────────────────────────────────────────────────────────────

router.get('/okr', async (req, res, next) => {
  try {
    const [goalsResult, krResult] = await Promise.all([
      pool.query(
        `SELECT id, title, description, status, due_date, created_at
         FROM goals WHERE workspace_id = $1
         ORDER BY created_at`,
        [req.workspace.id],
      ),
      pool.query(
        `SELECT kr.id, kr.goal_id, kr.title, kr.current_value, kr.target_value, kr.unit, kr.position
         FROM key_results kr
         JOIN goals g ON g.id = kr.goal_id
         WHERE g.workspace_id = $1
         ORDER BY kr.goal_id, kr.position`,
        [req.workspace.id],
      ),
    ]);

    const krsByGoal = new Map<string, typeof krResult.rows>();
    for (const kr of krResult.rows) {
      if (!krsByGoal.has(kr.goal_id)) krsByGoal.set(kr.goal_id, []);
      krsByGoal.get(kr.goal_id)!.push(kr);
    }

    const goals = goalsResult.rows.map((g) => {
      const krs = krsByGoal.get(g.id) ?? [];
      const progress = krs.length === 0
        ? (g.status === 'completed' ? 100 : 0)
        : Math.round(
            krs.reduce((sum, kr) => {
              const pct = kr.target_value > 0
                ? Math.min(100, (Number(kr.current_value) / Number(kr.target_value)) * 100)
                : 0;
              return sum + pct;
            }, 0) / krs.length,
          );
      return { ...g, progress, key_results: krs };
    });

    const summary = {
      total: goals.length,
      on_track: goals.filter((g) => g.status === 'active' && g.progress >= 70).length,
      at_risk:  goals.filter((g) => g.status === 'active' && g.progress < 70).length,
      completed: goals.filter((g) => g.status === 'completed').length,
    };

    res.json({ goals, summary });
  } catch (err) { next(err); }
});

export default router;
