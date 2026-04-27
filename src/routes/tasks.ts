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
  reorderTasks,
} from '../services/taskService.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  title:              z.string().min(1).max(500),
  description:        z.string().optional(),
  status:             z.enum(['todo', 'in_progress', 'done', 'blocked']).optional(),
  priority:           z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  assignee_clerk_id:  z.string().optional(),
  due_date:           z.string().date().optional(),
  tags:               z.array(z.string()).optional(),
  position:           z.number().int().optional(),
});

const updateSchema = createSchema.omit({ title: true }).extend({
  title: z.string().min(1).max(500).optional(),
});

const positionSchema = z.object({
  position: z.number().int().min(0),
});

// GET /api/tasks
router.get('/', async (req, res, next) => {
  try {
    const filters = {
      status:     req.query.status     as string | undefined,
      priority:   req.query.priority   as string | undefined,
      assignee:   req.query.assignee   as string | undefined,
      tag:        req.query.tag        as string | undefined,
      due_before: req.query.due_before as string | undefined,
      due_after:  req.query.due_after  as string | undefined,
    };
    const tasks = await getTasks(req.workspace.id, filters);
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
    res.status(201).json(task);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/reorder  — batch position update used by kanban drag-and-drop
const reorderSchema = z.object({
  taskId:      z.string().uuid(),
  newStatus:   z.enum(['todo', 'in_progress', 'done', 'blocked']),
  newPosition: z.number().int().min(0),
  resequence:  z.array(z.object({ id: z.string().uuid(), position: z.number().int().min(0) })).optional(),
});

router.post('/reorder', async (req, res, next) => {
  try {
    const parsed = reorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { taskId, newStatus, newPosition, resequence } = parsed.data;

    // Apply batch resequence first (includes the moved task)
    if (resequence && resequence.length > 0) {
      await reorderTasks(resequence, req.workspace.id);
    } else {
      await updateTaskPosition(taskId, req.workspace.id, newPosition);
    }

    // Update status if column changed
    const task = await updateTask(taskId, req.workspace.id, { status: newStatus });
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
    const task = await updateTask(req.params.id, req.workspace.id, parsed.data);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await logTaskActivity(task.id, req.auth.userId, 'updated', parsed.data as Record<string, unknown>);
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
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
