import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getTasks,
  createTask,
  getTaskById,
  updateTask,
  updateTaskPosition,
  softDeleteTask,
  logTaskActivity,
  reorderTaskInTransaction,
  spawnRecurringTask,
} from '../services/taskService.js';
import { getWorkload } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { fireWebhooks } from '../services/webhookService.js';

const router = Router();
router.use(requireWorkspace);

const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const RECURRENCE_RULES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

const createSchema = z.object({
  title:              z.string().min(1).max(500),
  description:        z.string().optional(),
  status:             z.enum(TASK_STATUSES).optional(),
  priority:           z.enum(TASK_PRIORITIES).optional(),
  assignee_clerk_id:  z.string().optional(),
  due_date:           z.string().date().optional(),
  tags:               z.array(z.string()).optional(),
  position:           z.number().int().optional(),
  sprint_id:          z.string().uuid().nullable().optional(),
  recurrence_rule:    z.enum(RECURRENCE_RULES).nullable().optional(),
});

const updateSchema = createSchema.omit({ title: true }).extend({
  title: z.string().min(1).max(500).optional(),
});

const filterSchema = z.object({
  status:     z.enum(TASK_STATUSES).optional(),
  priority:   z.enum(TASK_PRIORITIES).optional(),
  assignee:   z.string().optional(),
  tag:        z.string().optional(),
  due_before: z.string().date().optional(),
  due_after:  z.string().date().optional(),
  limit:      z.coerce.number().int().min(1).max(1000).optional(),
  offset:     z.coerce.number().int().min(0).optional(),
});

const positionSchema = z.object({
  position: z.number().int().min(0),
});

// GET /api/tasks/workload  — task counts per assignee per status (must be before /:id)
router.get('/workload', async (req, res, next) => {
  try {
    const rows = await getWorkload(req.workspace.id);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const parsed = filterSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { limit, offset, ...filters } = parsed.data;
    const tasks = await getTasks(req.workspace.id, filters, limit, offset);
    res.json(tasks);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const task = await createTask(req.workspace.id, parsed.data, req.auth.userId);
    await logTaskActivity(task.id, req.auth.userId, 'created');

    // Notify assignee if set and not self-assigning
    if (task.assignee_clerk_id && task.assignee_clerk_id !== req.auth.userId) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: task.assignee_clerk_id,
        type: 'task_assigned',
        title: `You were assigned "${task.title}"`,
        link: '/tasks',
      }).catch(() => {});
    }

    fireWebhooks(req.workspace.id, 'task.created', { task });

    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/reorder  — batch position + status update (kanban drag-and-drop)
const reorderSchema = z.object({
  taskId:      z.string().uuid(),
  newStatus:   z.enum(TASK_STATUSES),
  newPosition: z.number().int().min(0),
  resequence:  z.array(
    z.object({ id: z.string().uuid(), position: z.number().int().min(0) }),
  ).max(500).optional(),
});

router.post('/reorder', async (req, res, next) => {
  try {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { taskId, newStatus, newPosition, resequence } = parsed.data;

    const task = await reorderTaskInTransaction(
      taskId,
      req.workspace.id,
      newStatus,
      newPosition,
      resequence,
    );
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    await logTaskActivity(taskId, req.auth.userId, 'moved', { status: newStatus, position: newPosition });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/tasks/:id
router.get('/:id', async (req, res, next) => {
  try {
    const result = await getTaskById(req.params.id, req.workspace.id);
    if (!result) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    const task = await updateTask(req.params.id, req.workspace.id, parsed.data);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await logTaskActivity(task.id, req.auth.userId, 'updated', parsed.data as Record<string, unknown>);

    // Notify new assignee (if changed and not self-assigning)
    if (
      parsed.data.assignee_clerk_id &&
      parsed.data.assignee_clerk_id !== req.auth.userId
    ) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: parsed.data.assignee_clerk_id,
        type: 'task_assigned',
        title: `You were assigned "${task.title}"`,
        link: '/tasks',
      }).catch(() => {});
    }

    // Spawn recurring copy when task is completed
    if (parsed.data.status === 'done' && task.recurrence_rule) {
      spawnRecurringTask(task).catch(() => {});
    }

    // Fire webhooks
    if (parsed.data.status === 'done') {
      fireWebhooks(req.workspace.id, 'task.completed', { task });
    } else {
      fireWebhooks(req.workspace.id, 'task.updated', { task });
    }

    res.json(task);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tasks/:id/position
router.patch('/:id/position', async (req, res, next) => {
  try {
    const parsed = positionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const task = await updateTaskPosition(req.params.id, req.workspace.id, parsed.data.position);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await logTaskActivity(task.id, req.auth.userId, 'moved', { position: parsed.data.position });
    res.json(task);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await softDeleteTask(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    fireWebhooks(req.workspace.id, 'task.deleted', { taskId: req.params.id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
