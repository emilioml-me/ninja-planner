// External REST API — authenticated via API key (Bearer np_...) instead of Clerk session
// Mount: /api/external (before requireAuth in app.ts)
import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { apiKeyAuth, apiKeyAuthLimiter, requireScope } from '../middleware/apiKeyAuth.js';
import {
  createTask,
  updateTaskWithPrevState,
  logTaskActivity,
  isTaskDateInBounds,
  TASK_DATE_RANGE_MESSAGE,
} from '../services/taskService.js';
import { getRequestTz } from '../lib/tz.js';
import { runTaskStatusEffects } from '../services/taskStatusEffects.js';
import { fireWebhooks } from '../services/webhookService.js';
import { dispatchAutomations } from '../services/automationService.js';

const router = Router();
router.use(apiKeyAuthLimiter, apiKeyAuth);

const STATUS  = ['todo', 'in_progress', 'done', 'blocked'] as const;
const PRIORITY = ['urgent', 'high', 'medium', 'low'] as const;

const taskDate = () => z.string().date().refine(isTaskDateInBounds, { message: TASK_DATE_RANGE_MESSAGE });

const listQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/external/tasks?limit=&offset=  [tasks:read]
// Paginated (default 200, max 500 per page, newest first); X-Total-Count carries the total.
router.get('/tasks', requireScope('tasks:read'), async (req, res, next) => {
  try {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { limit, offset } = parsed.data;
    const { rows } = await pool.query(
      `SELECT id, title, status, priority, assignee_clerk_id, due_date, story_points, sprint_id, created_at, updated_at
       FROM tasks
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC, id
       LIMIT $2 OFFSET $3`,
      [req.workspace.id, limit, offset],
    );
    const total = rows.length < limit && (rows.length > 0 || offset === 0)
      ? offset + rows.length
      : parseInt((await pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM tasks WHERE workspace_id = $1 AND deleted_at IS NULL',
        [req.workspace.id],
      )).rows[0]?.count ?? '0', 10);
    res.setHeader('X-Total-Count', String(total));
    res.json(rows);
  } catch (err) { next(err); }
});

// Actor recorded for writes made through an API key (tasks.created_by and
// task_activity.actor_clerk_id are NOT NULL). apiKeyAuth always sets req.apiKey before these
// routes run, so activity is attributable to a specific key.
function apiKeyActor(req: Request): string {
  return req.apiKey?.id ? `apikey:${req.apiKey.id}` : 'apikey';
}

// POST /api/external/tasks  [tasks:write]
router.post('/tasks', requireScope('tasks:write'), async (req, res, next) => {
  try {
    const schema = z.object({
      title:    z.string().min(1).max(500),
      status:   z.enum(STATUS).default('todo'),
      priority: z.enum(PRIORITY).default('medium'),
      due_date: taskDate().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const actor = apiKeyActor(req);
    const task = await createTask(req.workspace.id, parsed.data, actor);
    await logTaskActivity(task.id, actor, 'created', { status: task.status, source: 'api' });
    fireWebhooks(req.workspace.id, 'task.created', { task });
    dispatchAutomations({
      type: 'task.created',
      workspaceId: req.workspace.id,
      taskId: task.id,
      assigneeId: task.assignee_clerk_id,
      title: task.title,
    }).catch(() => {});
    res.status(201).json({
      id: task.id, title: task.title, status: task.status, priority: task.priority,
      due_date: task.due_date, created_at: task.created_at,
    });
  } catch (err) { next(err); }
});

// PATCH /api/external/tasks/:id  [tasks:write]
router.patch('/tasks/:id', requireScope('tasks:write'), async (req, res, next) => {
  try {
    const schema = z.object({
      title:    z.string().min(1).max(500).optional(),
      status:   z.enum(STATUS).optional(),
      priority: z.enum(PRIORITY).optional(),
      due_date: taskDate().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // Same locked read-then-update + transition side effects as PATCH /api/tasks/:id, so an
    // API-driven completion spawns the next recurring instance, fires task.completed, runs
    // automations and goal milestones, and shows up in burndown/changelog.
    const result = await updateTaskWithPrevState(req.params.id, req.workspace.id, parsed.data);
    if (!result) { res.status(404).json({ error: 'Task not found' }); return; }
    const { task, prevStatus, changed } = result;
    const actor = apiKeyActor(req);

    // Nothing logged or announced when every sent value equals the stored one.
    if (Object.keys(changed).length > 0) {
      const statusChanged = await runTaskStatusEffects({
        workspaceId: req.workspace.id,
        actorUserId: actor,
        task,
        prevStatus,
        newStatus: task.status,
        source: 'external',
        activityPayload: changed,
        tz: getRequestTz(req),
      });
      if (!statusChanged) {
        await logTaskActivity(task.id, actor, 'updated', changed);
        fireWebhooks(req.workspace.id, 'task.updated', { task });
      }
    }

    res.json({
      id: task.id, title: task.title, status: task.status, priority: task.priority,
      due_date: task.due_date, updated_at: task.updated_at,
    });
  } catch (err) { next(err); }
});

// GET /api/external/roadmap  [roadmap:read]
// Previously roadmap:read/goals:read/sprints:read were issuable API-key scopes with no endpoint
// anywhere to actually use them — a workspace admin could create a completely non-functional
// API key. These three routes fill that in with the same read-only shape guestView.ts exposes.
router.get('/roadmap', requireScope('roadmap:read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, phase, status, priority, external_ref, created_at, updated_at
       FROM roadmap_items WHERE workspace_id = $1 ORDER BY priority, created_at
       LIMIT 200`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/external/goals  [goals:read]
router.get('/goals', requireScope('goals:read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, status, due_date, created_at, updated_at
       FROM goals WHERE workspace_id = $1 ORDER BY created_at DESC
       LIMIT 200`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/external/sprints  [sprints:read]
router.get('/sprints', requireScope('sprints:read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, goal, status, start_date, end_date, created_at, updated_at
       FROM sprints WHERE workspace_id = $1 ORDER BY created_at DESC
       LIMIT 200`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
