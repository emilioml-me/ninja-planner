import { pool } from '../config/db.js';
import { createNotification } from './notificationService.js';
import { resolveClerkEmail, sendGoalMilestoneEmail } from './emailService.js';
import { logger } from '../config/logger.js';

export interface Goal {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface GoalWithProgress extends Goal {
  total_tasks: number;
  done_tasks: number;
}

export interface GoalLink {
  id: string;
  goal_id: string;
  entity_type: string;
  entity_id: string;
  created_at: Date;
}

export async function getGoals(workspaceId: string): Promise<GoalWithProgress[]> {
  // total_tasks must apply the same deleted_at filter as done_tasks — otherwise a soft-deleted
  // task keeps inflating the denominator (or, once its sibling done task is also deleted,
  // corrupts the ratio the other way), permanently desyncing the displayed progress percentage.
  const result = await pool.query<GoalWithProgress>(
    `SELECT
       g.*,
       COUNT(t.id) FILTER (WHERE gl.entity_type = 'task' AND t.deleted_at IS NULL)::int                       AS total_tasks,
       COUNT(t.id) FILTER (WHERE gl.entity_type = 'task' AND t.status = 'done' AND t.deleted_at IS NULL)::int AS done_tasks
     FROM goals g
     LEFT JOIN goal_links gl ON gl.goal_id = g.id
     LEFT JOIN tasks t ON t.id = gl.entity_id AND gl.entity_type = 'task'
     WHERE g.workspace_id = $1
     GROUP BY g.id
     ORDER BY g.created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function createGoal(
  workspaceId: string,
  data: { title: string; description?: string; due_date?: string },
  createdBy: string,
): Promise<Goal> {
  const result = await pool.query<Goal>(
    `INSERT INTO goals (workspace_id, title, description, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workspaceId, data.title, data.description ?? null, data.due_date ?? null, createdBy],
  );
  return result.rows[0];
}

const GOAL_UPDATABLE = new Set(['title', 'description', 'status', 'due_date']);

export async function updateGoal(
  id: string,
  workspaceId: string,
  data: Partial<Pick<Goal, 'title' | 'description' | 'status' | 'due_date'>>,
): Promise<Goal | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && GOAL_UPDATABLE.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;
  values.push(id, workspaceId);
  const result = await pool.query<Goal>(
    `UPDATE goals SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteGoal(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM goals WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── goal links ──────────────────────────���─────────────────────��─────────────

export async function getGoalLinks(goalId: string, workspaceId: string): Promise<GoalLink[]> {
  const result = await pool.query<GoalLink>(
    `SELECT gl.* FROM goal_links gl
     JOIN goals g ON g.id = gl.goal_id
     WHERE gl.goal_id = $1 AND g.workspace_id = $2`,
    [goalId, workspaceId],
  );
  return result.rows;
}

export async function addGoalLink(
  goalId: string,
  workspaceId: string,
  entityType: string,
  entityId: string,
): Promise<GoalLink | null> {
  // Verify goal belongs to workspace
  const goalCheck = await pool.query(
    'SELECT id FROM goals WHERE id = $1 AND workspace_id = $2',
    [goalId, workspaceId],
  );
  if (goalCheck.rows.length === 0) throw new Error('Goal not found');

  // Tenant-isolation guard: the linked entity must belong to the same workspace as the goal.
  if (entityType === 'task') {
    const taskCheck = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2',
      [entityId, workspaceId],
    );
    if (taskCheck.rows.length === 0) throw new Error('Task not found in this workspace');
  }

  const result = await pool.query<GoalLink>(
    `INSERT INTO goal_links (goal_id, entity_type, entity_id, workspace_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (goal_id, entity_type, entity_id) DO NOTHING RETURNING *`,
    [goalId, entityType, entityId, workspaceId],
  );
  return result.rows[0] ?? null;
}

/**
 * Returns goals linked to a given task, with current progress counts.
 * Call AFTER the task status has already been updated in the DB.
 * Used to detect 50% / 100% milestone crossings.
 */
export async function getGoalProgressForTask(
  taskId: string,
  workspaceId: string,
): Promise<{ id: string; title: string; created_by: string; total_tasks: number; done_tasks: number }[]> {
  const result = await pool.query<{
    id: string; title: string; created_by: string; total_tasks: number; done_tasks: number;
  }>(
    `SELECT
       g.id, g.title, g.created_by,
       COUNT(t2.id) FILTER (WHERE gl2.entity_type = 'task' AND t2.deleted_at IS NULL)::int                       AS total_tasks,
       COUNT(t2.id) FILTER (WHERE gl2.entity_type = 'task' AND t2.status = 'done' AND t2.deleted_at IS NULL)::int AS done_tasks
     FROM goal_links gl
     JOIN goals g ON g.id = gl.goal_id AND g.workspace_id = $2
     LEFT JOIN goal_links gl2 ON gl2.goal_id = g.id
     LEFT JOIN tasks t2 ON t2.id = gl2.entity_id
     WHERE gl.entity_id = $1 AND gl.entity_type = 'task'
     GROUP BY g.id, g.title, g.created_by`,
    [taskId, workspaceId],
  );
  return result.rows;
}

export async function removeGoalLink(
  goalId: string,
  workspaceId: string,
  entityId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM goal_links gl USING goals g
     WHERE gl.goal_id = g.id AND gl.goal_id = $1 AND g.workspace_id = $2 AND gl.entity_id = $3`,
    [goalId, workspaceId, entityId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── milestone notifications ─────────────────────────────────────────────────

async function _notifyGoalMilestone(
  workspaceId: string,
  goal: { id: string; title: string; created_by: string },
  milestone: '50%' | '100%',
  workspaceUrl: string,
): Promise<void> {
  const dedupBody = `${goal.id}:${milestone === '100%' ? '100' : '50'}`;
  const title = milestone === '100%'
    ? `Goal complete: "${goal.title}"`
    : `Halfway there on "${goal.title}" (50%)`;

  // Permanent (not time-windowed) dedup: dedupBody is unique per (goal, milestone), and
  // checkAndNotifyGoalMilestones now re-evaluates "is this goal AT this milestone right now"
  // on every completion rather than trying to detect a "crossing" from a single-task delta —
  // so this guard is what makes repeated re-checks idempotent instead of re-notifying forever.
  // The email send below is gated on the same guard (via rowCount) so it doesn't re-fire
  // independently of the in-app notification.
  const inserted = await pool.query(
    `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
     SELECT $1, $2, 'goal_milestone', $3, $4, '/goals'
     WHERE NOT EXISTS (
       SELECT 1 FROM notifications
       WHERE workspace_id = $1 AND recipient_clerk_id = $2
         AND type = 'goal_milestone' AND body = $4
     )`,
    [workspaceId, goal.created_by, title, dedupBody],
  );
  if ((inserted.rowCount ?? 0) === 0) return;

  const user = await resolveClerkEmail(goal.created_by);
  if (user) {
    await sendGoalMilestoneEmail({
      to: user.email,
      recipientName: user.name,
      goalTitle: goal.title,
      milestone,
      workspaceUrl,
    });
  }
}

/**
 * After a task is marked done, check all linked goals for 50%/100% milestones and fire
 * dedup-guarded notifications + emails. Fire-and-forget — never throws.
 *
 * Evaluates each goal's CURRENT done/total ratio against the thresholds rather than trying to
 * infer a "just crossed" transition from `done_tasks - 1` (which assumed exactly one task
 * changed since the last check). Two tasks under the same goal completing close together could
 * jump done_tasks by more than 1 between reads, causing the old delta-based check to skip a
 * genuinely-crossed 50% threshold. Because _notifyGoalMilestone's dedup is now permanent per
 * (goal, milestone) rather than time-windowed, re-evaluating the current state on every call is
 * idempotent — it only actually notifies the first time a threshold is reached.
 */
export function checkAndNotifyGoalMilestones(
  taskId: string,
  workspaceId: string,
  workspaceUrl: string,
): void {
  getGoalProgressForTask(taskId, workspaceId).then(async (goals) => {
    for (const goal of goals) {
      if (goal.total_tasks === 0) continue;
      const pct = goal.done_tasks / goal.total_tasks;

      if (goal.done_tasks === goal.total_tasks) {
        await _notifyGoalMilestone(workspaceId, goal, '100%', workspaceUrl);
      } else if (pct >= 0.5) {
        await _notifyGoalMilestone(workspaceId, goal, '50%', workspaceUrl);
      }
    }
  }).catch((err) => {
    logger.warn({ err, taskId, workspaceId }, 'checkAndNotifyGoalMilestones failed');
  });
}
