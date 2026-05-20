import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { sendSlackMessage } from '../lib/slack.js';
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
import { pool } from '../config/db.js';
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

// POST /api/tasks/alert-check  — send Slack alert for overdue tasks  [admin only]
// Deduped: skips if an overdue_alert notification was sent for this workspace in last 20h
router.post('/alert-check', requireAdmin, async (req, res, next) => {
  try {
    // Dedup check — skip if already alerted in the last 20 hours
    const dedupCheck = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE workspace_id = $1
         AND type = 'overdue_alert'
         AND created_at > now() - INTERVAL '20 hours'`,
      [req.workspace.id],
    );
    if (parseInt(dedupCheck.rows[0].count, 10) > 0) {
      res.json({ ok: true, skipped: true, reason: 'Already alerted in the last 20 hours' });
      return;
    }

    // Query overdue tasks
    const overdueResult = await pool.query<{
      id: string; title: string; due_date: string;
      assignee_clerk_id: string | null; status: string;
    }>(
      `SELECT id, title, due_date, assignee_clerk_id, status
       FROM tasks
       WHERE workspace_id = $1
         AND status <> 'done'
         AND deleted_at IS NULL
         AND due_date < CURRENT_DATE
       ORDER BY due_date ASC
       LIMIT 50`,
      [req.workspace.id],
    );

    const tasks = overdueResult.rows;
    if (tasks.length === 0) {
      res.json({ ok: true, overdue: 0, alerted: false });
      return;
    }

    // Build Slack message
    const lines = tasks.slice(0, 15).map((t) =>
      `• *${t.title}* — due ${t.due_date} (${t.status.replace('_', ' ')})`,
    );
    const more = tasks.length > 15 ? `\n_…and ${tasks.length - 15} more_` : '';
    const msg =
      `:warning: *${tasks.length} overdue task${tasks.length === 1 ? '' : 's'}* in your workspace:\n` +
      lines.join('\n') + more;

    sendSlackMessage(msg);

    // In-app notification for workspace admins (the requesting admin at minimum)
    await createNotification({
      workspaceId: req.workspace.id,
      recipientClerkId: req.auth.userId,
      type: 'overdue_alert',
      title: `${tasks.length} overdue task${tasks.length === 1 ? '' : 's'} in this workspace`,
      link: '/tasks?status=overdue',
    });

    res.json({ ok: true, overdue: tasks.length, alerted: true });
  } catch (err) {
    next(err);
  }
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
    // Validate assignee is a member of this workspace (prevents external email spam)
    if (parsed.data.assignee_clerk_id) {
      const memberCheck = await pool.query(
        'SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
        [req.workspace.id, parsed.data.assignee_clerk_id],
      );
      if (memberCheck.rows.length === 0) {
        res.status(400).json({ error: 'Assignee is not a member of this workspace' });
        return;
      }
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

    // Due-date reminder — in-app only at creation (task-assigned email already covers it)
    if (task.assignee_clerk_id && task.due_date && task.assignee_clerk_id !== req.auth.userId) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: task.assignee_clerk_id,
        type: 'due_date_set',
        title: `"${task.title}" is due on ${task.due_date}`,
        link: '/tasks',
      }).catch(() => {});
      // No duplicate due-date email here — task-assigned email already includes the due date
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
    // Validate assignee is a member of this workspace (prevents external email spam)
    if (parsed.data.assignee_clerk_id) {
      const memberCheck = await pool.query(
        'SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
        [req.workspace.id, parsed.data.assignee_clerk_id],
      );
      if (memberCheck.rows.length === 0) {
        res.status(400).json({ error: 'Assignee is not a member of this workspace' });
        return;
      }
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
            // Dedup: don't re-notify if a 100% milestone notification was sent for this goal in the last 24h
            pool.query(
              `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
               SELECT $1, $2, 'goal_milestone', $3, $4, '/goals'
               WHERE NOT EXISTS (
                 SELECT 1 FROM notifications
                 WHERE workspace_id = $1 AND recipient_clerk_id = $2
                   AND type = 'goal_milestone' AND body = $4
                   AND created_at > NOW() - INTERVAL '24 hours'
               )`,
              [req.workspace.id, goal.created_by, `🎉 Goal complete: "${goal.title}"`, `${goal.id}:100`],
            ).catch(() => {});
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
            // Dedup: don't re-notify if a 50% milestone notification was sent for this goal in the last 24h
            pool.query(
              `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
               SELECT $1, $2, 'goal_milestone', $3, $4, '/goals'
               WHERE NOT EXISTS (
                 SELECT 1 FROM notifications
                 WHERE workspace_id = $1 AND recipient_clerk_id = $2
                   AND type = 'goal_milestone' AND body = $4
                   AND created_at > NOW() - INTERVAL '24 hours'
               )`,
              [req.workspace.id, goal.created_by, `Halfway there on "${goal.title}" (50%)`, `${goal.id}:50`],
            ).catch(() => {});
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

// DELETE /api/tasks/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
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
