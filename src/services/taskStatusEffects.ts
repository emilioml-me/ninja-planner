// Single source of truth for the side effects of a task status transition.
//
// Previously every path that could change a task's status (PATCH /api/tasks/:id, Kanban reorder,
// automation set_status, the ninja-task completion webhook, the external API, CSV import)
// hand-rolled its own subset of side effects — and most of them missed some: the reorder path
// skipped everything and logged 'moved' (which burndown/changelog ignore), the ninja-task
// webhook never spawned the next recurring instance, the external API fired nothing at all.
// Every status-changing path now calls runTaskStatusEffects instead.
import { logger } from '../config/logger.js';
import { pool } from '../config/db.js';
import { logTaskActivity, spawnRecurringTask, type Task } from './taskService.js';
import { fireWebhooks } from './webhookService.js';
import { dispatchAutomations } from './automationService.js';
import { checkAndNotifyGoalMilestones } from './goalService.js';
import { createNotification } from './notificationService.js';

export type TaskStatusEffectSource = 'patch' | 'reorder' | 'automation' | 'ninjatask' | 'external' | 'csv' | 'bulk';

export interface TaskStatusEffectOptions {
  workspaceId: string;
  /** Clerk user id of the human who caused the change, or null for system-driven changes. */
  actorUserId: string | null;
  task: Task;
  prevStatus: string | null;
  newStatus: string;
  source: TaskStatusEffectSource;
  /**
   * Extra fields merged into the 'updated' activity row (e.g. the other fields a PATCH changed
   * in the same request), so a single request produces a single activity row.
   */
  activityPayload?: Record<string, unknown>;
}

const workspaceUrl = () => process.env.ALLOWED_ORIGIN ?? 'https://ninja-planner.com';

/**
 * Runs every side effect of a status transition. No-op (returns false) when the status did not
 * actually change, so callers can pass the pre/post values unconditionally. Never throws for
 * fire-and-forget effects; the activity insert is awaited so burndown/changelog see it before
 * the caller responds.
 */
export async function runTaskStatusEffects(opts: TaskStatusEffectOptions): Promise<boolean> {
  const { workspaceId, actorUserId, task, prevStatus, newStatus, source } = opts;
  if (prevStatus === newStatus) return false;

  // task_activity.actor_clerk_id is NOT NULL — system-driven changes get a readable pseudo-actor.
  const actor = actorUserId || `system:${source}`;
  try {
    await logTaskActivity(task.id, actor, 'updated', { ...(opts.activityPayload ?? {}), status: newStatus });
  } catch (err) {
    logger.warn({ err, taskId: task.id, source }, '[taskStatusEffects] activity insert failed');
  }

  const becameDone = newStatus === 'done';

  if (becameDone && task.recurrence_rule) {
    spawnRecurringTask(task).catch((err) => {
      logger.warn({ err, taskId: task.id }, '[taskStatusEffects] spawnRecurringTask failed');
    });
  }

  fireWebhooks(workspaceId, becameDone ? 'task.completed' : 'task.updated', { task });

  // An automation-driven change must not re-dispatch task.status_changed, otherwise two rules
  // (e.g. "done -> todo" and "todo -> done") ping-pong forever.
  if (source !== 'automation' && prevStatus) {
    dispatchAutomations({
      type: 'task.status_changed',
      workspaceId,
      taskId: task.id,
      oldStatus: prevStatus,
      newStatus,
      assigneeId: task.assignee_clerk_id,
    }).catch(() => {});
  }

  if (becameDone) {
    checkAndNotifyGoalMilestones(task.id, workspaceId, workspaceUrl());
  }

  // Watchers — skip the actor themselves.
  pool.query<{ user_clerk_id: string }>(
    `SELECT user_clerk_id FROM task_watchers
     WHERE task_id = $1 AND workspace_id = $2 AND ($3::text IS NULL OR user_clerk_id <> $3)`,
    [task.id, workspaceId, actorUserId || null],
  ).then((watcherResult) => {
    for (const { user_clerk_id } of watcherResult.rows) {
      createNotification({
        workspaceId,
        recipientClerkId: user_clerk_id,
        type: 'task_updated',
        title: becameDone ? `Task completed: "${task.title}"` : `Task updated: "${task.title}"`,
        body: `A task you're watching moved to ${newStatus.replace('_', ' ')}.`,
        link: '/tasks',
      }).catch(() => {});
    }
  }).catch(() => {});

  return true;
}
