import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getSprints, getSprintById, createSprint, updateSprint, deleteSprint, getSprintTasks,
  snapshotSprintCommitment, type Sprint,
} from '../services/sprintService.js';
import { pool } from '../config/db.js';
import { getRequestTz, todayInTz } from '../lib/tz.js';
import { dispatchAutomations } from '../services/automationService.js';
import { fireWebhooks } from '../services/webhookService.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(requireWorkspace);

const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;

// Caps how long a sprint's date range can be — the burndown endpoint below builds one data
// point per day in this range, so an unbounded range (or end_date before start_date) turns a
// single GET into a synchronous, event-loop-blocking loop across every workspace's requests.
const MAX_SPRINT_DAYS = 366;

/** Returns an error message when the range is inverted or too long, else null. */
function dateRangeError(startDate: string | null | undefined, endDate: string | null | undefined): string | null {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) return 'end_date must not be before start_date';
  if (days > MAX_SPRINT_DAYS) return `Sprint range cannot exceed ${MAX_SPRINT_DAYS} days`;
  return null;
}

function validateDateRange(data: { start_date?: string | null; end_date?: string | null }, ctx: z.RefinementCtx) {
  const message = dateRangeError(data.start_date, data.end_date);
  if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ['end_date'] });
}

// goal is nullable so the client can clear it (sending null) — undefined means "unchanged".
const createSchema = z.object({
  name:       z.string().min(1).max(255),
  goal:       z.string().max(2000).nullable().optional(),
  status:     z.enum(SPRINT_STATUSES).optional(),
  start_date: z.string().date().nullable().optional(),
  end_date:   z.string().date().nullable().optional(),
}).superRefine(validateDateRange);

const updateSchema = z.object({
  name:       z.string().min(1).max(255).optional(),
  goal:       z.string().max(2000).nullable().optional(),
  status:     z.enum(SPRINT_STATUSES).optional(),
  start_date: z.string().date().nullable().optional(),
  end_date:   z.string().date().nullable().optional(),
}).superRefine(validateDateRange);

// GET /api/sprints
router.get('/', async (req, res, next) => {
  try {
    const sprints = await getSprints(req.workspace.id);
    res.json(sprints);

    // Fire-and-forget: check for sprints ending soon (≤ 2 days) and notify all admins.
    // Unlike /api/tasks/alert-check (which needs an external scheduler to ever run), this piggy-
    // backs on normal traffic — it only fires when someone in the workspace loads sprints, so a
    // sprint ending while nobody visits the app for days won't alert until someone next loads it.
    checkSprintEndAlerts(req.workspace.id, sprints).catch((err) => {
      logger.warn({ err, workspaceId: req.workspace.id }, '[sprints] checkSprintEndAlerts failed');
    });
  } catch (err) { next(err); }
});

// The alert check piggybacks on GET traffic; throttle it per workspace (per process) so every
// sprint-list load doesn't re-run the admin query + one insert per admin per ending sprint.
const SPRINT_ALERT_INTERVAL_MS = 10 * 60 * 1000;
const lastSprintAlertCheck = new Map<string, number>();

async function checkSprintEndAlerts(
  workspaceId: string,
  sprints: Awaited<ReturnType<typeof getSprints>>,
): Promise<void> {
  const now = Date.now();
  const last = lastSprintAlertCheck.get(workspaceId);
  if (last !== undefined && now - last < SPRINT_ALERT_INTERVAL_MS) return;
  lastSprintAlertCheck.set(workspaceId, now);
  if (lastSprintAlertCheck.size > 10_000) {
    // Bounded memory: drop entries old enough not to throttle anything anymore.
    for (const [id, ts] of lastSprintAlertCheck) {
      if (now - ts >= SPRINT_ALERT_INTERVAL_MS) lastSprintAlertCheck.delete(id);
    }
  }

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
    const body = `The sprint ends on ${sprint.end_date}.`;
    // One alert per (sprint, end date, days-left) per admin: at most one "2 days" and one
    // "1 day" alert, and moving the end date re-arms the alerts. Enforced by the unique
    // partial index on notifications.dedup_key (migration 052), so concurrent GETs can't
    // double-insert — the body stays human-readable instead of carrying the sprint id.
    const dedupKey = `sprint_ending:${sprint.id}:${sprint.end_date}:${daysLeft}`;

    for (const adminId of adminIds) {
      try {
        await pool.query(
          `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link, dedup_key)
           SELECT $1, $2, 'sprint_ending', $3, $4, '/sprints', $5
           WHERE NOT EXISTS (
             SELECT 1 FROM notification_preferences
             WHERE workspace_id = $1 AND clerk_user_id = $2 AND type = 'sprint_ending' AND enabled = false
           )
           ON CONFLICT (workspace_id, recipient_clerk_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
          [workspaceId, adminId, title, body, dedupKey],
        );
      } catch (err) {
        logger.warn({ err, workspaceId, adminId, sprintId: sprint.id }, '[sprints] sprint_ending notification insert failed');
      }
    }
  }
}

// POST /api/sprints  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const sprint = await createSprint(req.workspace.id, parsed.data, req.auth.userId);
    // Creating straight into active/completed is a transition from 'planning' — run the same
    // side effects PATCH would (commitment snapshot, quests, sprint.completed).
    await runSprintTransitionEffects(req.workspace.id, sprint, 'planning');
    res.status(201).json(sprint);
  } catch (err) { next(err); }
});

// GET /api/sprints/:id
router.get('/:id', async (req, res, next) => {
  try {
    const sprint = await getSprintById(req.params.id, req.workspace.id);
    if (!sprint) { res.status(404).json({ error: 'Sprint not found' }); return; }
    res.json(sprint);
  } catch (err) { next(err); }
});

// PATCH /api/sprints/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // The schema-level range check only runs when both dates are in the body — a partial PATCH
    // (e.g. only end_date) must be validated against the stored other bound too.
    if (parsed.data.start_date !== undefined || parsed.data.end_date !== undefined) {
      const existing = await getSprintById(req.params.id, req.workspace.id);
      if (!existing) { res.status(404).json({ error: 'Sprint not found' }); return; }
      const message = dateRangeError(
        parsed.data.start_date !== undefined ? parsed.data.start_date : existing.start_date,
        parsed.data.end_date !== undefined ? parsed.data.end_date : existing.end_date,
      );
      if (message) {
        res.status(400).json({ error: { formErrors: [], fieldErrors: { end_date: [message] } } });
        return;
      }
    }

    const updated = await updateSprint(req.params.id, req.workspace.id, parsed.data);
    if (!updated) { res.status(404).json({ error: 'Sprint not found' }); return; }
    const { prev_status: prevStatus, ...sprint } = updated;

    await runSprintTransitionEffects(req.workspace.id, sprint, prevStatus);

    // When completing a sprint, include the count of still-incomplete tasks
    if (sprint.status === 'completed') {
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

/**
 * Side effects of a sprint status transition (prevStatus -> sprint.status). Shared by PATCH and
 * by POST (a sprint created directly as active/completed is a transition from 'planning'), so
 * neither path skips them. The commitment snapshot is awaited (analytics depend on it being in
 * place before move-to-backlog runs); everything else is fire-and-forget.
 */
async function runSprintTransitionEffects(
  workspaceId: string,
  sprint: Sprint,
  prevStatus: string,
): Promise<void> {
  if (sprint.status === prevStatus) return;

  if (sprint.status === 'active') {
    await snapshotSprintCommitment(sprint.id, workspaceId, { onlyIfUnset: false });
  } else if (sprint.status === 'completed') {
    await snapshotSprintCommitment(sprint.id, workspaceId, { onlyIfUnset: true });
    dispatchAutomations({
      type: 'sprint.completed',
      workspaceId,
      sprintId: sprint.id,
      title: sprint.name,
    }).catch(() => {});
    fireWebhooks(workspaceId, 'sprint.completed', { sprint });
  }

  // Phase 5 — Sprint → Quest Sync: when a sprint TRANSITIONS to active, create a ninja-task
  // quest for every participating (non-viewer) workspace member who doesn't already have one
  // for this sprint. Gated on the transition (not on the payload merely containing
  // status='active') so ordinary edits of an active sprint don't mint duplicate quests.
  // Fire-and-forget; never blocks the response.
  if (sprint.status === 'active' && process.env.NINJA_TASK_URL && process.env.NINJA_TASK_API_KEY) {
    pool.query<{ clerk_user_id: string }>(
      `SELECT wm.clerk_user_id
       FROM workspace_members wm
       WHERE wm.workspace_id = $1
         AND wm.role <> 'viewer'
         AND NOT EXISTS (
           SELECT 1 FROM sprint_quests sq
           WHERE sq.sprint_id = $2 AND sq.clerk_user_id = wm.clerk_user_id
         )`,
      [workspaceId, sprint.id],
    ).then(async (membersResult) => {
      const { createQuestInNinjaTask } = await import("../integrations/ninjatask.js");
      for (const member of membersResult.rows) {
        try {
          const quest = await createQuestInNinjaTask({
            title: sprint.name,
            description: sprint.goal ?? null,
            clerkId: member.clerk_user_id,
          });
          // One quest is created per member, so it can't be represented by the single
          // sprints.ninja_task_quest_id column — this table tracks all of them, which is what
          // the quest_complete webhook needs to map an incoming questId back to a member.
          // UNIQUE (sprint_id, clerk_user_id) (migration 052) keeps it at one per member even
          // if two activations race.
          if (quest?.id) {
            await pool.query(
              `INSERT INTO sprint_quests (sprint_id, workspace_id, clerk_user_id, ninja_task_quest_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (sprint_id, clerk_user_id) DO NOTHING`,
              [sprint.id, workspaceId, member.clerk_user_id, quest.id],
            );
          }
        } catch (err) {
          logger.warn({ err, clerkUserId: member.clerk_user_id, sprintId: sprint.id }, '[ninja-task] quest create failed for member');
        }
      }
    }).catch((err: Error) => logger.warn({ err, sprintId: sprint.id }, '[ninja-task] member fetch failed'));
  }
}

// POST /api/sprints/:id/move-to-backlog — unassign all non-done tasks from sprint  [admin only]
router.post('/:id/move-to-backlog', requireAdmin, async (req, res, next) => {
  try {
    const sprintCheck = await pool.query<{ id: string }>(
      'SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }

    // Record what the sprint committed to before its unfinished work leaves it (no-op when the
    // snapshot was already taken at activation).
    await snapshotSprintCommitment(req.params.id, req.workspace.id, { onlyIfUnset: true });

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
    const tz = getRequestTz(req);
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

    // For each task currently done, its completion date is the FIRST transition to done after
    // its last non-done status (i.e. the start of its current "done" streak). Taking the latest
    // status='done' row instead meant any later activity row repeating status='done' (an edit of
    // a done task, a Kanban move within the Done column) moved its completion to that day.
    // Status-carrying rows are 'updated', 'created' (task created directly as done) and
    // historical 'moved' rows (Kanban drags logged the status there before the reorder path
    // switched to logging 'updated').
    const doneByDay = await pool.query<{ done_date: string; task_count: number; point_sum: number }>(
      `WITH status_rows AS (
         SELECT ta.task_id, ta.created_at, ta.payload->>'status' AS status
         FROM task_activity ta
         JOIN tasks t ON t.id = ta.task_id
         WHERE t.sprint_id = $1
           AND t.workspace_id = $2
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
       final_done AS (
         SELECT sr.task_id,
                (MIN(sr.created_at) AT TIME ZONE $3)::date::text AS done_date
         FROM status_rows sr
         LEFT JOIN last_reopen lr ON lr.task_id = sr.task_id
         WHERE sr.status = 'done'
           AND (lr.reopened_at IS NULL OR sr.created_at > lr.reopened_at)
         GROUP BY sr.task_id
       )
       SELECT
         fd.done_date,
         COUNT(*)::int                                     AS task_count,
         COALESCE(SUM(t.story_points), 0)::int             AS point_sum
       FROM final_done fd
       JOIN tasks t ON t.id = fd.task_id
       GROUP BY fd.done_date
       ORDER BY fd.done_date`,
      [req.params.id, req.workspace.id, tz],
    );

    // Build date series start_date..min(today, end_date). Defensively re-clamped here (in
    // addition to the create/update validation) so a sprint row with an extreme or inverted
    // range — from data written before validation existed, or any other path — can't turn this
    // GET into a synchronous loop of tens of thousands of iterations.
    // All date math is in UTC ('YYYY-MM-DD' parses as UTC midnight) so the series doesn't shift
    // by a day depending on the server's local timezone.
    const start = new Date(`${start_date}T00:00:00Z`);
    let end = new Date(`${end_date}T00:00:00Z`);
    if (end < start) {
      res.json({ total_tasks, total_points, points: [] });
      return;
    }
    const maxEnd = new Date(start);
    maxEnd.setUTCDate(maxEnd.getUTCDate() + MAX_SPRINT_DAYS);
    if (end > maxEnd) end = maxEnd;
    // "Today" and completion days are in the requester's timezone (K6), so the series matches
    // the calendar the user sees instead of rolling over at UTC midnight.
    const today = new Date(`${todayInTz(tz)}T00:00:00Z`);
    const last  = end < today ? end : today;

    // Tasks completed before the sprint started (e.g. finished, then pulled into the sprint)
    // are burned down at day 0 rather than never being subtracted at all.
    const startStr = start.toISOString().split('T')[0];
    let preStartTasks = 0;
    let preStartPoints = 0;
    const doneMap = new Map<string, { tasks: number; points: number }>();
    for (const row of doneByDay.rows) {
      if (row.done_date < startStr) {
        preStartTasks  += row.task_count;
        preStartPoints += row.point_sum;
      } else {
        doneMap.set(row.done_date, { tasks: row.task_count, points: row.point_sum });
      }
    }

    const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

    const dataPoints: {
      date: string;
      remaining_tasks: number;
      remaining_points: number;
      ideal_tasks: number;
      ideal_points: number;
    }[] = [];

    let doneTasks = preStartTasks;
    let donePoints = preStartPoints;

    for (let i = 0; ; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
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
         -- Omitted fields keep their stored value (send '' to clear one).
         went_well    = COALESCE(EXCLUDED.went_well, sprint_retros.went_well),
         to_improve   = COALESCE(EXCLUDED.to_improve, sprint_retros.to_improve),
         action_items = COALESCE(EXCLUDED.action_items, sprint_retros.action_items),
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
    const sprintCheck = await pool.query<{ status: string }>(
      'SELECT status FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }
    if (sprintCheck.rows[0].status === 'completed') {
      res.status(409).json({ error: 'Cannot add tasks to a completed sprint' }); return;
    }

    // Tasks that already belong to a completed sprint stay there (their history is part of that
    // sprint's record); only backlog tasks or tasks in open sprints are moved.
    const result = await pool.query(
      `UPDATE tasks t SET sprint_id = $1
       WHERE t.id = ANY($2::uuid[]) AND t.workspace_id = $3 AND t.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM sprints s WHERE s.id = t.sprint_id AND s.status = 'completed'
         )`,
      [req.params.id, parsed.data.task_ids, req.workspace.id],
    );
    const assigned = result.rowCount ?? 0;
    if (assigned === 0) { res.status(404).json({ error: 'No assignable tasks found' }); return; }
    res.json({ ok: true, assigned, skipped: new Set(parsed.data.task_ids).size - assigned });
  } catch (err) { next(err); }
});

// DELETE /api/sprints/:id/tasks/:taskId  — remove task from sprint  [admin only, like bulk assign]
router.delete('/:id/tasks/:taskId', requireAdmin, async (req, res, next) => {
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
