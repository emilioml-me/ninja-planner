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
import { getGoalProgressForTask } from '../services/goalService.js';
import {
  sendTaskAssignedEmail,
  sendDueDateReminderEmail,
  sendGoalMilestoneEmail,
  resolveClerkEmail,
} from '../services/emailService.js';

const router = Router();
router.use(requireWorkspace);

const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const RECURRENCE_RULES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

const checklistItemSchema = z.object({
  id:   z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  done: z.boolean(),
});

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
  checklist:          z.array(checklistItemSchema).max(50).optional(),
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

      // Email: task assigned
      resolveClerkEmail(task.assignee_clerk_id).then((user) => {
        if (!user) return;
        return sendTaskAssignedEmail({
          to: user.email,
          recipientName: user.name,
          taskTitle: task.title,
          assigner: req.auth.userId,
          workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
        });
      }).catch(() => {});
    }

    fireWebhooks(req.workspace.id, 'task.created', { task });

    // Due-date reminder — notify assignee when a due date is set at creation
    if (task.assignee_clerk_id && task.due_date && task.assignee_clerk_id !== req.auth.userId) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: task.assignee_clerk_id,
        type: 'due_date_set',
        title: `"${task.title}" is due on ${task.due_date}`,
        link: '/tasks',
      }).catch(() => {});

      // Email: due date reminder
      resolveClerkEmail(task.assignee_clerk_id).then((user) => {
        if (!user) return;
        return sendDueDateReminderEmail({
          to: user.email,
          recipientName: user.name,
          taskTitle: task.title,
          dueDate: task.due_date!,
          workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
        });
      }).catch(() => {});
    }

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

      // Email: task assigned
      resolveClerkEmail(parsed.data.assignee_clerk_id).then((user) => {
        if (!user) return;
        return sendTaskAssignedEmail({
          to: user.email,
          recipientName: user.name,
          taskTitle: task.title,
          assigner: req.auth.userId,
          workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
        });
      }).catch(() => {});
    }

    // Spawn recurring copy when task is completed
    if (parsed.data.status === 'done' && task.recurrence_rule) {
      spawnRecurringTask(task).catch(() => {});
    }

    // Due-date reminder — notify assignee when due_date is explicitly set/changed
    if (parsed.data.due_date !== undefined && task.assignee_clerk_id && task.assignee_clerk_id !== req.auth.userId) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: task.assignee_clerk_id,
        type: 'due_date_set',
        title: task.due_date
          ? `"${task.title}" is due on ${task.due_date}`
          : `Due date removed from "${task.title}"`,
        link: '/tasks',
      }).catch(() => {});

      // Email: due date reminder (only when a date is actually set, not cleared)
      if (task.due_date) {
        resolveClerkEmail(task.assignee_clerk_id).then((user) => {
          if (!user) return;
          return sendDueDateReminderEmail({
            to: user.email,
            recipientName: user.name,
            taskTitle: task.title,
            dueDate: task.due_date!,
            workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
          });
        }).catch(() => {});
      }
    }

    // Goal milestone notifications — when task marked done, check 50%/100% crossings
    if (parsed.data.status === 'done') {
      getGoalProgressForTask(task.id, req.workspace.id).then((goals) => {
        for (const goal of goals) {
          if (goal.total_tasks === 0) continue;
          const pct = goal.done_tasks / goal.total_tasks;
          const prevPct = (goal.done_tasks - 1) / goal.total_tasks;
          const crossed50  = pct >= 0.5 && prevPct < 0.5;
          const crossed100 = goal.done_tasks === goal.total_tasks && goal.done_tasks > 0;

          if (crossed100) {
            createNotification({
              workspaceId: req.workspace.id,
              recipientClerkId: goal.created_by,
              type: 'goal_milestone',
              title: `🎉 Goal complete: "${goal.title}"`,
              link: '/goals',
            }).catch(() => {});
            resolveClerkEmail(goal.created_by).then((user) => {
              if (!user) return;
              return sendGoalMilestoneEmail({
                to: user.email,
                recipientName: user.name,
                goalTitle: goal.title,
                milestone: '100%',
                workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
              });
            }).catch(() => {});
          } else if (crossed50) {
            createNotification({
              workspaceId: req.workspace.id,
              recipientClerkId: goal.created_by,
              type: 'goal_milestone',
              title: `Halfway there on "${goal.title}" (50%)`,
              link: '/goals',
            }).catch(() => {});
            resolveClerkEmail(goal.created_by).then((user) => {
              if (!user) return;
              return sendGoalMilestoneEmail({
                to: user.email,
                recipientName: user.name,
                goalTitle: goal.title,
                milestone: '50%',
                workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
              });
            }).catch(() => {});
          }
        }
      }).catch(() => {});
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
