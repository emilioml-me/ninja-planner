import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getSprints, createSprint, updateSprint, deleteSprint, getSprintTasks,
} from '../services/sprintService.js';
import { pool } from '../config/db.js';
import { createNotification } from '../services/notificationService.js';

const router = Router();
router.use(requireWorkspace);

const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;

const createSchema = z.object({
  name:       z.string().min(1).max(255),
  goal:       z.string().optional(),
  status:     z.enum(SPRINT_STATUSES).optional(),
  start_date: z.string().date().nullable().optional(),
  end_date:   z.string().date().nullable().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/sprints
router.get('/', async (req, res, next) => {
  try {
    const sprints = await getSprints(req.workspace.id);
    res.json(sprints);

    // Fire-and-forget: check for sprints ending soon (≤ 2 days) and notify all admins
    checkSprintEndAlerts(req.workspace.id, sprints).catch(() => {});
  } catch (err) { next(err); }
});

async function checkSprintEndAlerts(
  workspaceId: string,
  sprints: Awaited<ReturnType<typeof getSprints>>,
): Promise<void> {
  const now = Date.now();
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

  // Query all workspace admins to notify (not just the requesting user)
  const adminResult = await pool.query<{ clerk_user_id: string }>(
    `SELECT clerk_user_id FROM workspace_members
     WHERE workspace_id = $1 AND role IN ('org:admin', 'org:owner')`,
    [workspaceId],
  );
  if (adminResult.rows.length === 0) return;
  const adminIds = adminResult.rows.map((r) => r.clerk_user_id);

  for (const sprint of sprints) {
    if (sprint.status !== 'active' || !sprint.end_date) continue;
    const endsAt = new Date(sprint.end_date + 'T23:59:59').getTime();
    const msLeft = endsAt - now;
    if (msLeft <= 0 || msLeft > twoDaysMs) continue;

    const daysLeft = Math.ceil(msLeft / 86_400_000);
    const title = `Sprint "${sprint.name}" ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;

    // Atomic dedup: insert for each admin only if no sprint_ending notification for this
    // sprint+admin already exists in the last 20 hours. Single INSERT per admin avoids
    // the SELECT-then-INSERT race condition.
    for (const adminId of adminIds) {
      pool.query(
        `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
         SELECT $1, $2, 'sprint_ending', $3, $4, '/sprints'
         WHERE NOT EXISTS (
           SELECT 1 FROM notifications
           WHERE workspace_id = $1
             AND recipient_clerk_id = $2
             AND type = 'sprint_ending'
             AND body = $4
             AND created_at > NOW() - INTERVAL '20 hours'
         )`,
        [workspaceId, adminId, title, sprint.id],
      ).catch(() => {});
    }
  }
}

// POST /api/sprints  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    res.status(201).json(await createSprint(req.workspace.id, parsed.data, req.auth.userId));
  } catch (err) { next(err); }
});

// PATCH /api/sprints/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const sprint = await updateSprint(req.params.id, req.workspace.id, parsed.data);
    if (!sprint) { res.status(404).json({ error: 'Sprint not found' }); return; }

    // When completing a sprint, include the count of still-incomplete tasks
    if (parsed.data.status === 'completed') {
      const incompleteResult = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM tasks
         WHERE sprint_id = $1 AND workspace_id = $2 AND status <> 'done' AND deleted_at IS NULL`,
        [req.params.id, req.workspace.id],
      );
      res.json({ sprint, incomplete_count: incompleteResult.rows[0].count });
    } else {
      res.json({ sprint, incomplete_count: 0 });
    }
  } catch (err) { next(err); }
});

// POST /api/sprints/:id/move-to-backlog — unassign all non-done tasks from sprint  [admin only]
router.post('/:id/move-to-backlog', requireAdmin, async (req, res, next) => {
  try {
    const sprintCheck = await pool.query<{ id: string }>(
      'SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }

    const result = await pool.query<{ count: number }>(
      `WITH moved AS (
         UPDATE tasks SET sprint_id = NULL
         WHERE sprint_id = $1 AND workspace_id = $2 AND status <> 'done' AND deleted_at IS NULL
         RETURNING id
       )
       SELECT COUNT(*)::int AS count FROM moved`,
      [req.params.id, req.workspace.id],
    );
    res.json({ moved: result.rows[0].count });
  } catch (err) { next(err); }
});

// DELETE /api/sprints/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteSprint(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Sprint not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/sprints/:id/tasks
router.get('/:id/tasks', async (req, res, next) => {
  try {
    res.json(await getSprintTasks(req.params.id, req.workspace.id));
  } catch (err) { next(err); }
});

// GET /api/sprints/:id/burndown  — daily remaining tasks + ideal line
router.get('/:id/burndown', async (req, res, next) => {
  try {
    // Load sprint + total task/points counts
    const sprintResult = await pool.query<{
      start_date: string | null; end_date: string | null;
      total_tasks: number; total_points: number;
    }>(
      `SELECT
         s.start_date, s.end_date,
         COUNT(t.id)::int                                     AS total_tasks,
         COALESCE(SUM(t.story_points), 0)::int                AS total_points
       FROM sprints s
       LEFT JOIN tasks t ON t.sprint_id = s.id AND t.deleted_at IS NULL
       WHERE s.id = $1 AND s.workspace_id = $2
       GROUP BY s.id`,
      [req.params.id, req.workspace.id],
    );

    if (sprintResult.rows.length === 0) {
      res.status(404).json({ error: 'Sprint not found' });
      return;
    }

    const { start_date, end_date, total_tasks, total_points } = sprintResult.rows[0];

    if (!start_date || !end_date) {
      res.json({ total_tasks, total_points, points: [] });
      return;
    }

    // For each task currently done, find the latest activity row where status='done'
    const doneByDay = await pool.query<{ done_date: string; task_count: number; point_sum: number }>(
      `WITH final_done AS (
         SELECT DISTINCT ON (ta.task_id)
           ta.task_id,
           DATE(ta.created_at AT TIME ZONE 'UTC')::text AS done_date
         FROM task_activity ta
         JOIN tasks t ON t.id = ta.task_id
         WHERE t.sprint_id = $1
           AND t.workspace_id = $2
           AND t.status = 'done'
           AND ta.action = 'updated'
           AND (ta.payload->>'status') = 'done'
           AND t.deleted_at IS NULL
         ORDER BY ta.task_id, ta.created_at DESC
       )
       SELECT
         fd.done_date,
         COUNT(*)::int                                     AS task_count,
         COALESCE(SUM(t.story_points), 0)::int             AS point_sum
       FROM final_done fd
       JOIN tasks t ON t.id = fd.task_id
       GROUP BY fd.done_date
       ORDER BY fd.done_date`,
      [req.params.id, req.workspace.id],
    );

    // Build date series start_date..min(today, end_date)
    const start = new Date(start_date);
    const end   = new Date(end_date);
    const today = new Date();
    const last  = end < today ? end : today;

    const doneMap = new Map<string, { tasks: number; points: number }>();
    for (const row of doneByDay.rows) {
      doneMap.set(row.done_date, { tasks: row.task_count, points: row.point_sum });
    }

    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

    const dataPoints: {
      date: string;
      remaining_tasks: number;
      remaining_points: number;
      ideal_tasks: number;
      ideal_points: number;
    }[] = [];

    let doneTasks = 0;
    let donePoints = 0;

    for (let i = 0; ; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      if (d > last) break;

      const dateStr = d.toISOString().split('T')[0];
      const entry = doneMap.get(dateStr);
      if (entry) {
        doneTasks  += entry.tasks;
        donePoints += entry.points;
      }

      const progress = days > 1 ? i / (days - 1) : 1;
      dataPoints.push({
        date: dateStr,
        remaining_tasks:  total_tasks - doneTasks,
        remaining_points: total_points - donePoints,
        ideal_tasks:      Math.round(total_tasks  * (1 - progress)),
        ideal_points:     Math.round(total_points * (1 - progress)),
      });
    }

    res.json({ start_date, end_date, total_tasks, total_points, points: dataPoints });
  } catch (err) { next(err); }
});

// ─── Retrospective ────────────────────────────────────────────────────────────

const retroSchema = z.object({
  went_well:    z.string().max(5000).optional(),
  to_improve:   z.string().max(5000).optional(),
  action_items: z.string().max(5000).optional(),
});

// GET /api/sprints/:id/retro
router.get('/:id/retro', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sr.* FROM sprint_retros sr
       JOIN sprints s ON s.id = sr.sprint_id
       WHERE sr.sprint_id = $1 AND s.workspace_id = $2`,
      [req.params.id, req.workspace.id],
    );
    if (result.rows.length === 0) {
      res.json(null);
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) { next(err); }
});

// PUT /api/sprints/:id/retro  — upsert (admin only)
router.put('/:id/retro', requireAdmin, async (req, res, next) => {
  try {
    const parsed = retroSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const sprintCheck = await pool.query(
      'SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }

    const { went_well, to_improve, action_items } = parsed.data;
    const result = await pool.query(
      `INSERT INTO sprint_retros (sprint_id, workspace_id, went_well, to_improve, action_items, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sprint_id) DO UPDATE SET
         went_well    = EXCLUDED.went_well,
         to_improve   = EXCLUDED.to_improve,
         action_items = EXCLUDED.action_items,
         updated_at   = now()
       RETURNING *`,
      [req.params.id, req.workspace.id, went_well ?? null, to_improve ?? null, action_items ?? null, req.auth.userId],
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/sprints/:id/tasks  — bulk assign tasks to sprint  [admin only]
router.patch('/:id/tasks', requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({ task_ids: z.array(z.string().uuid()).min(1).max(100) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    // verify sprint belongs to workspace
    const sprintCheck = await pool.query(
      'SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }

    await pool.query(
      `UPDATE tasks SET sprint_id = $1
       WHERE id = ANY($2::uuid[]) AND workspace_id = $3 AND deleted_at IS NULL`,
      [req.params.id, parsed.data.task_ids, req.workspace.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/sprints/:id/tasks/:taskId  — remove task from sprint
router.delete('/:id/tasks/:taskId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE tasks SET sprint_id = NULL
       WHERE id = $1 AND sprint_id = $2 AND workspace_id = $3 AND deleted_at IS NULL`,
      [req.params.taskId, req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) {
      res.status(404).json({ error: 'Task not found in this sprint' });
      return;
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
