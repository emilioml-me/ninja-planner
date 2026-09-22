import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { sendSlackMessage } from '../lib/slack.js';
import {
  getTasks,
  countTasks,
  createTask,
  getTaskById,
  updateTaskWithPrevState,
  updateTaskPosition,
  softDeleteTask,
  logTaskActivity,
  reorderTaskInTransaction,
  assertLinkableToWorkspace,
  claimNinjaTaskSync,
  resolveNinjaTaskSync,
  releaseNinjaTaskSync,
} from '../services/taskService.js';
import { runTaskStatusEffects } from '../services/taskStatusEffects.js';
import { getWorkload } from '../services/commentService.js';
import { pool } from '../config/db.js';
import { createNotification } from '../services/notificationService.js';
import { fireWebhooks } from '../services/webhookService.js';
import {
  sendTaskAssignedEmail,
  sendDueDateReminderEmail,
  resolveClerkEmail,
} from '../services/emailService.js';
import { dispatchAutomations } from '../services/automationService.js';
import { pushTaskToNinjaTask } from '../integrations/ninjatask.js';

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
  description:        z.string().max(10000).optional(),
  status:             z.enum(TASK_STATUSES).optional(),
  priority:           z.enum(TASK_PRIORITIES).optional(),
  assignee_clerk_id:  z.string().nullable().optional(),   // null = unassigned
  due_date:           z.string().date().nullable().optional(), // null = no due date
  start_date:         z.string().date().nullable().optional(),
  tags:               z.array(z.string()).optional(),
  position:           z.number().int().optional(),
  sprint_id:          z.string().uuid().nullable().optional(),
  epic_id:            z.string().uuid().nullable().optional(),
  recurrence_rule:    z.enum(RECURRENCE_RULES).nullable().optional(),
  story_points:       z.number().int().min(0).max(144).nullable().optional(),
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

const DEFAULT_CAPACITY_POINTS = 20;
const WORKSPACE_URL = () => process.env.ALLOWED_ORIGIN ?? 'https://ninja-planner.com';

// Recipient id of the dedup marker row written for each overdue alert run. Not a real Clerk id,
// so it never shows up in anyone's notification list (every listing filters by recipient), but
// it is written regardless of any admin's notification preferences. Previously the dedup relied
// on the in-app notification row, which isn't inserted when the recipient muted overdue_alert,
// so a muted admin triggered a fresh Slack alert on every call.
const OVERDUE_ALERT_MARKER_RECIPIENT = '__system:overdue_alert__';

// POST /api/tasks/alert-check  — send Slack alert for overdue tasks  [admin only]
// Deduped: skips if an overdue alert already ran for this workspace in the last 20h.
//
// SCHEDULER DEPENDENCY: this route only runs when something calls it (an external scheduler or
// an admin). The due-date automation trigger has its own in-process scheduler
// (services/automationService.ts startDueDateScheduler); this Slack digest does not.
router.post('/alert-check', requireAdmin, async (req, res, next) => {
  try {
    const workspaceId = req.workspace.id;
    const client = await pool.connect();
    let tasks: { id: string; title: string; due_date: string; status: string }[] = [];
    let totalOverdue = 0;
    try {
      await client.query('BEGIN');
      // Serializes concurrent alert-checks for the same workspace (double click, several
      // containers, overlapping scheduler runs) so only one of them can pass the dedup check.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('overdue_alert:' || $1::text))", [workspaceId]);

      // Any overdue_alert row in the window (the marker below, or a legacy per-admin
      // notification) counts as "already alerted".
      const dedupCheck = await client.query(
        `SELECT 1 FROM notifications
         WHERE workspace_id = $1
           AND type = 'overdue_alert'
           AND created_at > now() - INTERVAL '20 hours'
         LIMIT 1`,
        [workspaceId],
      );
      if (dedupCheck.rows.length > 0) {
        await client.query('COMMIT');
        res.json({ ok: true, skipped: true, reason: 'Already alerted in the last 20 hours' });
        return;
      }

      // LIMIT 50 caps the preview lines; the true count comes from a separate COUNT(*).
      const overdueResult = await client.query<{ id: string; title: string; due_date: string; status: string }>(
        `SELECT id, title, due_date, status
         FROM tasks
         WHERE workspace_id = $1
           AND status <> 'done'
           AND deleted_at IS NULL
           AND due_date < CURRENT_DATE
         ORDER BY due_date ASC
         LIMIT 50`,
        [workspaceId],
      );
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM tasks
         WHERE workspace_id = $1
           AND status <> 'done'
           AND deleted_at IS NULL
           AND due_date < CURRENT_DATE`,
        [workspaceId],
      );
      tasks = overdueResult.rows;
      totalOverdue = parseInt(countResult.rows[0].count, 10);

      if (totalOverdue > 0) {
        await client.query(
          `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title)
           VALUES ($1, $2, 'overdue_alert', 'overdue alert dedup marker')`,
          [workspaceId, OVERDUE_ALERT_MARKER_RECIPIENT],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (totalOverdue === 0) {
      res.json({ ok: true, overdue: 0, alerted: false });
      return;
    }

    // Build Slack message (sendSlackMessage only posts for operator workspaces and escapes text)
    const lines = tasks.slice(0, 15).map((t) =>
      `- *${t.title}* - due ${t.due_date} (${t.status.replace('_', ' ')})`,
    );
    const more = totalOverdue > 15 ? `\n_...and ${totalOverdue - 15} more_` : '';
    const msg =
      `:warning: *${totalOverdue} overdue task${totalOverdue === 1 ? '' : 's'}* in your workspace:\n` +
      lines.join('\n') + more;

    sendSlackMessage(msg, workspaceId).catch((err: Error) => console.error('[alert-check] slack send failed:', err));

    // In-app notification for every workspace admin (each subject to their own preferences)
    const admins = await pool.query<{ clerk_user_id: string }>(
      `SELECT clerk_user_id FROM workspace_members
       WHERE workspace_id = $1 AND role IN ('org:admin', 'org:owner')`,
      [workspaceId],
    );
    const recipients = new Set(admins.rows.map((r) => r.clerk_user_id));
    recipients.add(req.auth.userId);
    for (const recipientClerkId of recipients) {
      createNotification({
        workspaceId,
        recipientClerkId,
        type: 'overdue_alert',
        title: `${totalOverdue} overdue task${totalOverdue === 1 ? '' : 's'} in this workspace`,
        link: '/tasks?status=overdue',
      }).catch(() => {});
    }

    res.json({ ok: true, overdue: totalOverdue, alerted: true });
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

// GET /api/tasks/capacity?sprint_id=...  — story points assigned per member in a sprint
// (defaults to the active sprint) + configured capacity, preferring a per-sprint override
// over the member's workspace-wide default.
//
// Response: one row per current workspace member (including members with no tasks, so their
// capacity can still be configured):
//   { user_clerk_id, assigned_points, task_count, capacity_points, default_capacity_points,
//     is_override, sprint_id }
// is_override=true means capacity_points comes from a per-sprint override for `sprint_id`, so an
// edit of the displayed value should PUT with that sprint_id; otherwise edit the default.
const capacityQuerySchema = z.object({
  sprint_id: z.string().uuid().optional(),
});

router.get('/capacity', async (req, res, next) => {
  try {
    const parsedQuery = capacityQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) { res.status(400).json({ error: parsedQuery.error.flatten() }); return; }
    const requestedSprintId = parsedQuery.data.sprint_id;

    // Resolve the effective sprint ONCE so the points and capacity queries agree.
    let sprintId = requestedSprintId ?? null;
    if (!sprintId) {
      const activeSprint = await pool.query<{ id: string }>(
        "SELECT id FROM sprints WHERE workspace_id = $1 AND status = 'active' LIMIT 1",
        [req.workspace.id],
      );
      sprintId = activeSprint.rows[0]?.id ?? null;
    }

    const membersResult = await pool.query<{ clerk_user_id: string }>(
      'SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 ORDER BY clerk_user_id',
      [req.workspace.id],
    );

    // Points assigned per member across the target sprint's tasks
    const pointsResult = await pool.query<{ user_clerk_id: string; assigned_points: number; task_count: number }>(
      `SELECT
         t.assignee_clerk_id AS user_clerk_id,
         COALESCE(SUM(t.story_points), 0)::int AS assigned_points,
         COUNT(t.id)::int                      AS task_count
       FROM tasks t
       JOIN sprints s ON s.id = t.sprint_id AND s.workspace_id = t.workspace_id AND s.id = $2
       WHERE t.workspace_id = $1
         AND t.assignee_clerk_id IS NOT NULL
         AND t.deleted_at IS NULL
         AND t.status <> 'done'
       GROUP BY t.assignee_clerk_id`,
      [req.workspace.id, sprintId],
    );

    // Configured capacity per member: per-sprint override first, workspace default otherwise
    const capacityResult = await pool.query<{ user_clerk_id: string; capacity_points: number; sprint_id: string | null }>(
      `SELECT user_clerk_id, capacity_points, sprint_id
       FROM member_capacity
       WHERE workspace_id = $1 AND (sprint_id IS NULL OR sprint_id = $2)`,
      [req.workspace.id, sprintId],
    );

    const defaultMap: Record<string, number> = {};
    const overrideMap: Record<string, number> = {};
    for (const row of capacityResult.rows) {
      if (row.sprint_id === null) defaultMap[row.user_clerk_id] = row.capacity_points;
      else overrideMap[row.user_clerk_id] = row.capacity_points;
    }
    const pointsMap = new Map(pointsResult.rows.map((r) => [r.user_clerk_id, r]));

    // Departed members are excluded (only current workspace_members rows are listed).
    const rows = membersResult.rows.map(({ clerk_user_id }) => {
      const points = pointsMap.get(clerk_user_id);
      const defaultCapacity = defaultMap[clerk_user_id] ?? DEFAULT_CAPACITY_POINTS;
      const override = overrideMap[clerk_user_id];
      return {
        user_clerk_id: clerk_user_id,
        assigned_points: points?.assigned_points ?? 0,
        task_count: points?.task_count ?? 0,
        capacity_points: override ?? defaultCapacity,
        default_capacity_points: defaultCapacity,
        is_override: override !== undefined,
        sprint_id: sprintId,
      };
    });

    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/tasks/capacity/:memberId  — set capacity for a member (admin only)
// Body may include sprint_id to set a one-sprint override instead of the workspace-wide default.
router.put('/capacity/:memberId', requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      capacity_points: z.number().int().min(0).max(500),
      sprint_id: z.string().uuid().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const sprintId = parsed.data.sprint_id ?? null;

    // Verify the target user is actually a member of this workspace before writing.
    const memberCheck = await pool.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [req.workspace.id, req.params.memberId],
    );
    if (memberCheck.rows.length === 0) {
      res.status(404).json({ error: 'Member not found in this workspace' }); return;
    }

    if (sprintId) {
      const sprintCheck = await pool.query(
        'SELECT 1 FROM sprints WHERE id = $1 AND workspace_id = $2',
        [sprintId, req.workspace.id],
      );
      if (sprintCheck.rows.length === 0) {
        res.status(404).json({ error: 'Sprint not found in this workspace' }); return;
      }
      await pool.query(
        `INSERT INTO member_capacity (workspace_id, user_clerk_id, sprint_id, capacity_points)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, user_clerk_id, sprint_id) WHERE sprint_id IS NOT NULL DO UPDATE SET
           capacity_points = EXCLUDED.capacity_points,
           updated_at = now()`,
        [req.workspace.id, req.params.memberId, sprintId, parsed.data.capacity_points],
      );
    } else {
      await pool.query(
        `INSERT INTO member_capacity (workspace_id, user_clerk_id, sprint_id, capacity_points)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT (workspace_id, user_clerk_id) WHERE sprint_id IS NULL DO UPDATE SET
           capacity_points = EXCLUDED.capacity_points,
           updated_at = now()`,
        [req.workspace.id, req.params.memberId, parsed.data.capacity_points],
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
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
    const effectiveLimit = Math.min(limit ?? 500, 1000);
    const effectiveOffset = offset ?? 0;
    const tasks = await getTasks(req.workspace.id, filters, effectiveLimit, effectiveOffset);
    // X-Total-Count lets the client detect truncation (default page size is 500). The extra
    // COUNT(*) only runs when the page is full; otherwise the total is known from this page.
    const total = tasks.length < effectiveLimit && (tasks.length > 0 || effectiveOffset === 0)
      ? effectiveOffset + tasks.length
      : await countTasks(req.workspace.id, filters);
    res.setHeader('X-Total-Count', String(total));
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
    // M5: include status so tasks created as 'done' appear in the changelog
    await logTaskActivity(task.id, req.auth.userId, 'created', { status: task.status });

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
          workspaceUrl: WORKSPACE_URL(),
        });
      }).catch(() => {});
    }

    fireWebhooks(req.workspace.id, 'task.created', { task });
    dispatchAutomations({
      type: 'task.created',
      workspaceId: req.workspace.id,
      taskId: task.id,
      assigneeId: task.assignee_clerk_id,
      title: task.title,
    }).catch(() => {});

    // Push to ninja-task if assignee is set and integration is configured
    if (task.assignee_clerk_id && process.env.NINJA_TASK_URL && process.env.NINJA_TASK_API_KEY) {
      pushTaskToNinjaTask({
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.due_date,
        tags: task.tags ?? [],
        clerkId: task.assignee_clerk_id,
      }).then((result) => {
        if (result?.id) {
          resolveNinjaTaskSync(task.id, result.id)
            .catch((err: Error) => console.error('[ninja-task] failed to store external_id:', err));
        }
      }).catch((err: Error) => console.error('[ninja-task] task push failed:', err));
    }

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

    const result = await reorderTaskInTransaction(
      taskId,
      req.workspace.id,
      newStatus,
      newPosition,
      resequence,
    );
    if (!result) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    // A drag across columns is a status change like any other: logged as 'updated' (which
    // burndown/changelog count) with the full set of transition side effects. A same-column
    // drag is only a position change.
    const statusChanged = await runTaskStatusEffects({
      workspaceId: req.workspace.id,
      actorUserId: req.auth.userId,
      task: result.task,
      prevStatus: result.prevStatus,
      newStatus: result.task.status,
      source: 'reorder',
      activityPayload: { position: newPosition },
    });
    if (!statusChanged) {
      await logTaskActivity(taskId, req.auth.userId, 'moved', { position: newPosition });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

type TaskUpdateResult = NonNullable<Awaited<ReturnType<typeof updateTaskWithPrevState>>>;
type TaskUpdateData = z.infer<typeof updateSchema>;

/**
 * Every side effect of a task update, shared by PATCH /api/tasks/:id and POST /api/tasks/bulk.
 * Status transitions go through runTaskStatusEffects (activity, recurring spawn, webhooks,
 * automations, goal milestones, watchers); non-status updates log one 'updated' activity row,
 * fire task.updated and notify watchers. Assignee/due-date notifications only fire on an actual
 * change, never on a value merely echoed in a full-object PATCH.
 */
async function runTaskUpdateSideEffects(opts: {
  workspaceId: string;
  actorUserId: string;
  data: TaskUpdateData;
  result: TaskUpdateResult;
  source: 'patch' | 'bulk';
  /** Bulk updates skip per-task emails (in-app notifications still fire) to avoid mail floods. */
  sendEmails: boolean;
}): Promise<void> {
  const { workspaceId, actorUserId, data, result, source, sendEmails } = opts;
  const { task, prevAssigneeClerkId, prevStatus, prevDueDate } = result;

  const assigneeActuallyChanged =
    data.assignee_clerk_id !== undefined && data.assignee_clerk_id !== prevAssigneeClerkId;
  const statusActuallyChanged =
    data.status !== undefined && data.status !== prevStatus;
  const dueDateActuallyChanged =
    data.due_date !== undefined && data.due_date !== prevDueDate;

  if (statusActuallyChanged) {
    await runTaskStatusEffects({
      workspaceId,
      actorUserId,
      task,
      prevStatus,
      newStatus: task.status,
      source,
      activityPayload: data as Record<string, unknown>,
    });
  } else {
    await logTaskActivity(task.id, actorUserId, 'updated', data as Record<string, unknown>);
    fireWebhooks(workspaceId, 'task.updated', { task });

    // Notify watchers (fire-and-forget, skip the user who made the update)
    pool.query<{ user_clerk_id: string }>(
      `SELECT user_clerk_id FROM task_watchers
       WHERE task_id = $1 AND workspace_id = $2 AND user_clerk_id <> $3`,
      [task.id, workspaceId, actorUserId],
    ).then((watcherResult) => {
      for (const { user_clerk_id } of watcherResult.rows) {
        createNotification({
          workspaceId,
          recipientClerkId: user_clerk_id,
          type: 'task_updated',
          title: `Task updated: "${task.title}"`,
          body: `A task you're watching was updated.`,
          link: '/tasks',
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  if (assigneeActuallyChanged && data.assignee_clerk_id && data.assignee_clerk_id !== actorUserId) {
    const assigneeId = data.assignee_clerk_id;
    createNotification({
      workspaceId,
      recipientClerkId: assigneeId,
      type: 'task_assigned',
      title: `You were assigned "${task.title}"`,
      link: '/tasks',
    }).catch(() => {});

    if (sendEmails) {
      resolveClerkEmail(assigneeId).then((user) => {
        if (!user) return;
        return sendTaskAssignedEmail({
          to: user.email,
          recipientName: user.name,
          taskTitle: task.title,
          assigner: actorUserId,
          workspaceUrl: WORKSPACE_URL(),
        });
      }).catch(() => {});
    }
  }

  if (dueDateActuallyChanged && task.assignee_clerk_id && task.assignee_clerk_id !== actorUserId) {
    const assigneeId = task.assignee_clerk_id;
    createNotification({
      workspaceId,
      recipientClerkId: assigneeId,
      type: 'due_date_set',
      title: task.due_date
        ? `"${task.title}" is due on ${task.due_date}`
        : `Due date removed from "${task.title}"`,
      link: '/tasks',
    }).catch(() => {});

    // Email: due date reminder (only when a date is actually set, not cleared)
    if (sendEmails && task.due_date) {
      const dueDate = task.due_date;
      resolveClerkEmail(assigneeId).then((user) => {
        if (!user) return;
        return sendDueDateReminderEmail({
          to: user.email,
          recipientName: user.name,
          taskTitle: task.title,
          dueDate,
          workspaceUrl: WORKSPACE_URL(),
        });
      }).catch(() => {});
    }
  }

  if (assigneeActuallyChanged && data.assignee_clerk_id) {
    dispatchAutomations({
      type: 'task.assigned',
      workspaceId,
      taskId: task.id,
      assigneeId: data.assignee_clerk_id,
      title: task.title,
    }).catch(() => {});
  }

  // Push to ninja-task when assignee is set for the first time on an existing task
  if (
    assigneeActuallyChanged &&
    data.assignee_clerk_id &&
    !prevAssigneeClerkId &&
    process.env.NINJA_TASK_URL &&
    process.env.NINJA_TASK_API_KEY
  ) {
    const assigneeId = data.assignee_clerk_id;
    // Atomically claim the sync slot so two concurrent PATCHes assigning this task for the
    // first time can't both see "not yet synced" and both push a duplicate ninja-task.
    claimNinjaTaskSync(task.id, workspaceId).then((claimed) => {
      if (!claimed) return;
      pushTaskToNinjaTask({
        title: task.title,
        description: task.description,
        priority: task.priority,
        dueDate: task.due_date,
        tags: task.tags ?? [],
        clerkId: assigneeId,
      }).then((pushResult) => {
        if (pushResult?.id) {
          resolveNinjaTaskSync(task.id, pushResult.id)
            .catch((err: Error) => console.error('[ninja-task] failed to store external_id on patch:', err));
        } else {
          releaseNinjaTaskSync(task.id)
            .catch((err: Error) => console.error('[ninja-task] failed to release sync slot on patch:', err));
        }
      }).catch((err: Error) => {
        console.error('[ninja-task] task push on patch failed:', err);
        releaseNinjaTaskSync(task.id)
          .catch((releaseErr: Error) => console.error('[ninja-task] failed to release sync slot on patch:', releaseErr));
      });
    }).catch((err: Error) => console.error('[ninja-task] failed to claim sync slot on patch:', err));
  }
}

// POST /api/tasks/bulk  — bulk update or delete up to 200 tasks in one request
// (replaces N parallel PATCH/DELETE calls from the Tasks page, which tripped the rate limiter).
// Body:
//   { action: 'update', ids: uuid[], changes: { status?, priority?, assignee_clerk_id?, sprint_id? } }
//   { action: 'delete', ids: uuid[] }                                  [admin only, like DELETE /:id]
// Response: { ok: true, action, updated | deleted: number, not_found: string[] }
// Same auth/validation as the single-task routes; each updated task gets the full PATCH side
// effects (status transitions via runTaskStatusEffects), except per-task emails.
const bulkIdsSchema = z.array(z.string().uuid()).min(1).max(200);
const bulkSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update'),
    ids: bulkIdsSchema,
    changes: z.object({
      status:            z.enum(TASK_STATUSES).optional(),
      priority:          z.enum(TASK_PRIORITIES).optional(),
      assignee_clerk_id: z.string().nullable().optional(),
      sprint_id:         z.string().uuid().nullable().optional(),
    }).strict(),
  }),
  z.object({
    action: z.literal('delete'),
    ids: bulkIdsSchema,
  }),
]);

router.post(
  '/bulk',
  (req, res, next) => {
    if (req.body && typeof req.body === 'object' && req.body.action === 'delete') {
      requireAdmin(req, res, next);
      return;
    }
    next();
  },
  async (req, res, next) => {
    try {
      const parsed = bulkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const ids = [...new Set(parsed.data.ids)];

      if (parsed.data.action === 'delete') {
        const { rows } = await pool.query<{ id: string }>(
          `UPDATE tasks SET deleted_at = now()
           WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND deleted_at IS NULL
           RETURNING id`,
          [ids, req.workspace.id],
        );
        const deletedIds = new Set(rows.map((r) => r.id));
        for (const id of deletedIds) {
          fireWebhooks(req.workspace.id, 'task.deleted', { taskId: id });
        }
        res.json({
          ok: true,
          action: 'delete',
          deleted: deletedIds.size,
          not_found: ids.filter((id) => !deletedIds.has(id)),
        });
        return;
      }

      const changes = parsed.data.changes;
      if (Object.keys(changes).length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }
      if (changes.assignee_clerk_id) {
        const memberCheck = await pool.query(
          'SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
          [req.workspace.id, changes.assignee_clerk_id],
        );
        if (memberCheck.rows.length === 0) {
          res.status(400).json({ error: 'Assignee is not a member of this workspace' });
          return;
        }
      }
      // Validate once up front instead of failing half-way through the loop.
      await assertLinkableToWorkspace('sprints', changes.sprint_id, req.workspace.id);

      let updated = 0;
      const notFound: string[] = [];
      // Sequential on purpose: each update takes a pooled connection for its row lock, and a
      // 200-wide Promise.all would starve the pool for every other tenant.
      for (const id of ids) {
        const result = await updateTaskWithPrevState(id, req.workspace.id, changes);
        if (!result) { notFound.push(id); continue; }
        updated++;
        await runTaskUpdateSideEffects({
          workspaceId: req.workspace.id,
          actorUserId: req.auth.userId,
          data: changes,
          result,
          source: 'bulk',
          sendEmails: false,
        });
      }
      res.json({ ok: true, action: 'update', updated, not_found: notFound });
    } catch (err) {
      next(err);
    }
  },
);

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
    // Reads the pre-update assignee/status and applies the update in one locked transaction,
    // so a concurrent PATCH on the same task can't slip in between the read and the write and
    // cause this request to dispatch automations with a stale "previous status".
    const updateResult = await updateTaskWithPrevState(req.params.id, req.workspace.id, parsed.data);
    if (!updateResult) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    await runTaskUpdateSideEffects({
      workspaceId: req.workspace.id,
      actorUserId: req.auth.userId,
      data: parsed.data,
      result: updateResult,
      source: 'patch',
      sendEmails: true,
    });

    res.json(updateResult.task);
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
