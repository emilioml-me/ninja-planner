// GET /api/analytics/velocity   — sprint velocity (last 12 completed sprints)
// GET /api/analytics/time-report — time-log aggregation with filters
// GET /api/analytics/okr         — OKR roll-up with computed progress
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';
import { getRequestTz } from '../lib/tz.js';

const router = Router();
router.use(requireWorkspace);

// ── Velocity ──────────────────────────────────────────────────────────────────

router.get('/velocity', async (req, res, next) => {
  try {
    // "Committed" (total_points) is the scope snapshotted when the sprint was activated
    // (sprints.committed_points, migration 060). Falls back to the points still in the sprint
    // for sprints completed before the snapshot existed — those can overstate delivery because
    // move-to-backlog strips unfinished work. committed_snapshot tells the client which it is.
    const { rows } = await pool.query(
      `SELECT
         s.id,
         s.name,
         s.start_date,
         s.end_date,
         COALESCE(s.committed_points, COALESCE(SUM(t.story_points), 0))::int                    AS total_points,
         (s.committed_points IS NOT NULL)                                                       AS committed_snapshot,
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

// Each filter must be a single string (repeated params arrive as arrays -> 400); an empty
// value means "no filter".
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);
const timeReportQuerySchema = z.object({
  member:    z.preprocess(emptyToUndefined, z.string().max(255).optional()),
  sprint_id: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
  from:      z.preprocess(emptyToUndefined, z.string().date().optional()),
  to:        z.preprocess(emptyToUndefined, z.string().date().optional()),
}).refine((q) => !(q.from && q.to && q.from > q.to), { message: 'from must be on or before to', path: ['to'] });

router.get('/time-report', async (req, res, next) => {
  try {
    const q = timeReportQuerySchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ error: q.error.flatten() }); return; }
    const { member, sprint_id, from, to } = q.data;

    const conditions: string[] = ['tl.workspace_id = $1'];
    const values: unknown[] = [req.workspace.id];
    let i = 2;

    if (member)    { conditions.push(`tl.user_clerk_id = $${i++}`); values.push(member); }
    if (sprint_id) { conditions.push(`t.sprint_id = $${i++}`);      values.push(sprint_id); }
    // from/to are calendar days in the requester's timezone (K6): bound logged_at by that zone's
    // local midnights instead of casting to UTC days (which put late-evening logs in the wrong
    // month at report edges). Written as a range on the raw column so it stays index-friendly.
    const tz = getRequestTz(req);
    if (from) {
      conditions.push(`tl.logged_at >= ($${i++}::date::timestamp AT TIME ZONE $${i++})`);
      values.push(from, tz);
    }
    if (to) {
      conditions.push(`tl.logged_at < (($${i++}::date + 1)::timestamp AT TIME ZONE $${i++})`);
      values.push(to, tz);
    }

    const [{ rows }, summaryResult] = await Promise.all([
      pool.query(
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
      ),
      // Summary totals are computed from a separate, unbounded aggregate rather than reducing
      // over the LIMIT-1000 detail rows above — a workspace logging >1000 billable entries in
      // the requested range (e.g. a quarter-long report used for client invoicing) would
      // otherwise get a billable_value silently understated by whatever fell outside the cap.
      pool.query<{ total_minutes: string; billable_minutes: string; billable_value: string; row_count: string }>(
        `SELECT
           COALESCE(SUM(tl.minutes), 0)::bigint AS total_minutes,
           COALESCE(SUM(tl.minutes) FILTER (WHERE tl.billable), 0)::bigint AS billable_minutes,
           COALESCE(SUM((tl.minutes / 60.0) * tl.hourly_rate) FILTER (WHERE tl.billable AND tl.hourly_rate IS NOT NULL), 0) AS billable_value,
           COUNT(*) AS row_count
         FROM time_logs tl
         JOIN tasks     t ON t.id = tl.task_id
         WHERE ${conditions.join(' AND ')}`,
        values,
      ),
    ]);

    const summaryRow = summaryResult.rows[0];

    res.json({
      rows,
      truncated: rows.length === 1000 && parseInt(summaryRow.row_count, 10) > 1000,
      summary: {
        total_minutes: parseInt(summaryRow.total_minutes, 10),
        billable_minutes: parseInt(summaryRow.billable_minutes, 10),
        billable_value: Math.round(parseFloat(summaryRow.billable_value) * 100) / 100,
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
         ORDER BY created_at
         LIMIT 500`,
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
              const target = Number(kr.target_value);
              const current = Number(kr.current_value);
              // target 0 means "drive it down to zero": met (100%) when current <= 0. Matches the
              // Goals page's KR progress rule.
              const pct = target > 0
                ? Math.max(0, Math.min(100, (current / target) * 100))
                : (current <= 0 ? 100 : 0);
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
