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

// Counts both linked tasks (done = status='done') and linked roadmap_items (done = status='live')
// toward progress. Previously only entity_type='task' links were counted — a goal linked solely
// to roadmap_items (a valid link type accepted by POST /:id/links) silently showed 0/0 progress
// forever and could never trigger the 50%/100% milestone emails.
const PROGRESS_JOIN_AND_COUNTS = `
       COUNT(t.id) FILTER (WHERE gl.entity_type = 'task' AND t.deleted_at IS NULL)::int
         + COUNT(ri.id) FILTER (WHERE gl.entity_type = 'roadmap_item')::int                                     AS total_tasks,
       COUNT(t.id) FILTER (WHERE gl.entity_type = 'task' AND t.status = 'done' AND t.deleted_at IS NULL)::int
         + COUNT(ri.id) FILTER (WHERE gl.entity_type = 'roadmap_item' AND ri.status = 'live')::int              AS done_tasks`;

export interface KeyResult {
  id: string;
  goal_id: string;
  workspace_id: string;
  title: string;
  /** NUMERIC columns stay strings on the wire (pg default). */
  target_value: string;
  current_value: string;
  unit: string;
  position: number;
  created_at: Date;
  updated_at: Date;
}

const GOALS_LIST_LIMIT = 500;

export async function getGoals(workspaceId: string): Promise<(GoalWithProgress & { key_results: KeyResult[] })[]> {
  // total_tasks must apply the same deleted_at filter as done_tasks — otherwise a soft-deleted
  // task keeps inflating the denominator (or, once its sibling done task is also deleted,
  // corrupts the ratio the other way), permanently desyncing the displayed progress percentage.
  const result = await pool.query<GoalWithProgress>(
    `SELECT
       g.*,
       ${PROGRESS_JOIN_AND_COUNTS}
     FROM goals g
     LEFT JOIN goal_links gl ON gl.goal_id = g.id
     LEFT JOIN tasks t ON t.id = gl.entity_id AND gl.entity_type = 'task'
     LEFT JOIN roadmap_items ri ON ri.id = gl.entity_id AND gl.entity_type = 'roadmap_item'
     WHERE g.workspace_id = $1
     GROUP BY g.id
     ORDER BY g.created_at DESC
     LIMIT ${GOALS_LIST_LIMIT}`,
    [workspaceId],
  );

  // Key results for every listed goal in one query (avoids an N+1 fetch per goal card).
  const goalIds = result.rows.map((g) => g.id);
  const byGoal = new Map<string, KeyResult[]>();
  if (goalIds.length > 0) {
    const krs = await pool.query<KeyResult>(
      `SELECT * FROM key_results
       WHERE workspace_id = $1 AND goal_id = ANY($2::uuid[])
       ORDER BY position, created_at`,
      [workspaceId, goalIds],
    );
    for (const kr of krs.rows) {
      const list = byGoal.get(kr.goal_id);
      if (list) list.push(kr);
      else byGoal.set(kr.goal_id, [kr]);
    }
  }
  return result.rows.map((g) => ({ ...g, key_results: byGoal.get(g.id) ?? [] }));
}

/** Goal creator for permission checks (admin OR goal owner may delete/unlink). */
export async function getGoalOwner(id: string, workspaceId: string): Promise<string | null> {
  const r = await pool.query<{ created_by: string }>(
    'SELECT created_by FROM goals WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return r.rows[0]?.created_by ?? null;
}

export async function getGoalById(id: string, workspaceId: string): Promise<GoalWithProgress | null> {
  const result = await pool.query<GoalWithProgress>(
    `SELECT
       g.*,
       ${PROGRESS_JOIN_AND_COUNTS}
     FROM goals g
     LEFT JOIN goal_links gl ON gl.goal_id = g.id
     LEFT JOIN tasks t ON t.id = gl.entity_id AND gl.entity_type = 'task'
     LEFT JOIN roadmap_items ri ON ri.id = gl.entity_id AND gl.entity_type = 'roadmap_item'
     WHERE g.id = $1 AND g.workspace_id = $2
     GROUP BY g.id`,
    [id, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function createGoal(
  workspaceId: string,
  data: { title: string; description?: string | null; due_date?: string | null },
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
): Promise<(Goal & { prev_status: string }) | null> {
  // prev_status is the status immediately before this update, read under a row lock in the
  // same statement, so callers fire goal.completed only on a real transition.
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
  const result = await pool.query<Goal & { prev_status: string }>(
    `WITH prev AS (
       SELECT id, status FROM goals WHERE id = $${i++} AND workspace_id = $${i} FOR UPDATE
     )
     UPDATE goals g SET ${fields.join(', ')}
     FROM prev
     WHERE g.id = prev.id
     RETURNING g.*, prev.status AS prev_status`,
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
  // Links to soft-deleted tasks are hidden (the link row is kept so a restore brings it back).
  const result = await pool.query<GoalLink>(
    `SELECT gl.* FROM goal_links gl
     JOIN goals g ON g.id = gl.goal_id
     LEFT JOIN tasks t ON gl.entity_type = 'task' AND t.id = gl.entity_id
     WHERE gl.goal_id = $1 AND g.workspace_id = $2
       AND (gl.entity_type <> 'task' OR (t.id IS NOT NULL AND t.deleted_at IS NULL))
     ORDER BY gl.created_at
     LIMIT 1000`,
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
  // status: 404 so the central error handler returns a 404 with this message instead of a 500.
  if (goalCheck.rows.length === 0) throw Object.assign(new Error('Goal not found'), { status: 404 });

  // Tenant-isolation guard: the linked entity must belong to the same workspace as the goal.
  if (entityType === 'task') {
    const taskCheck = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [entityId, workspaceId],
    );
    if (taskCheck.rows.length === 0) {
      throw Object.assign(new Error('Task not found in this workspace'), { status: 404 });
    }
  } else if (entityType === 'roadmap_item') {
    const itemCheck = await pool.query(
      'SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
      [entityId, workspaceId],
    );
    if (itemCheck.rows.length === 0) {
      throw Object.assign(new Error('Roadmap item not found in this workspace'), { status: 404 });
    }
  } else {
    throw Object.assign(new Error('Unsupported link type'), { status: 400 });
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
  return getGoalProgressForEntity('task', taskId, workspaceId);
}

/**
 * Same as getGoalProgressForTask, for any linkable entity (task | roadmap_item).
 */
export async function getGoalProgressForEntity(
  entityType: 'task' | 'roadmap_item',
  entityId: string,
  workspaceId: string,
): Promise<{ id: string; title: string; created_by: string; total_tasks: number; done_tasks: number }[]> {
  // Same "count tasks + roadmap_items toward progress" logic as getGoals/getGoalById — a goal
  // with both task and roadmap_item links must use the same totals here as it displays
  // elsewhere, or milestone thresholds would fire against a different percentage than the UI
  // shows.
  const result = await pool.query<{
    id: string; title: string; created_by: string; total_tasks: number; done_tasks: number;
  }>(
    `SELECT
       g.id, g.title, g.created_by,
       COUNT(t2.id) FILTER (WHERE gl2.entity_type = 'task' AND t2.deleted_at IS NULL)::int
         + COUNT(ri2.id) FILTER (WHERE gl2.entity_type = 'roadmap_item')::int                                      AS total_tasks,
       COUNT(t2.id) FILTER (WHERE gl2.entity_type = 'task' AND t2.status = 'done' AND t2.deleted_at IS NULL)::int
         + COUNT(ri2.id) FILTER (WHERE gl2.entity_type = 'roadmap_item' AND ri2.status = 'live')::int             AS done_tasks
     FROM goal_links gl
     JOIN goals g ON g.id = gl.goal_id AND g.workspace_id = $2
     LEFT JOIN goal_links gl2 ON gl2.goal_id = g.id
     LEFT JOIN tasks t2 ON t2.id = gl2.entity_id AND gl2.entity_type = 'task'
     LEFT JOIN roadmap_items ri2 ON ri2.id = gl2.entity_id AND gl2.entity_type = 'roadmap_item'
     WHERE gl.entity_id = $1 AND gl.entity_type = $3
     GROUP BY g.id, g.title, g.created_by`,
    [entityId, workspaceId, entityType],
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
  const dedupKey = `goal_milestone:${goal.id}:${milestone === '100%' ? '100' : '50'}`;
  const title = milestone === '100%'
    ? `Goal complete: "${goal.title}"`
    : `Halfway there on "${goal.title}" (50%)`;
  const body = milestone === '100%'
    ? `All work linked to "${goal.title}" is done.`
    : `Half of the work linked to "${goal.title}" is done.`;

  // The goal creator may have left the workspace since creating the goal — don't notify or
  // email someone who can no longer open it.
  const member = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
    [workspaceId, goal.created_by],
  );
  if (member.rows.length === 0) return;

  // Permanent (not time-windowed) dedup: dedup_key is unique per (goal, milestone), and
  // checkAndNotifyGoalMilestones re-evaluates "is this goal AT this milestone right now"
  // on every completion rather than trying to detect a "crossing" from a single-task delta —
  // so this guard is what makes repeated re-checks idempotent instead of re-notifying forever.
  // The email send below is gated on the same guard (via rowCount) so it doesn't re-fire
  // independently of the in-app notification.
  //
  // Backed by the unique dedup_key index (migration 052) — ON CONFLICT DO NOTHING makes a
  // concurrent second writer lose atomically instead of racing on a read.
  //
  // A muted recipient still gets the row, stored as already read: that records the milestone so
  // unmuting later doesn't fire a stale "halfway there" for a goal that passed 50% long ago.
  const muted = await pool.query(
    `SELECT 1 FROM notification_preferences
     WHERE workspace_id = $1 AND clerk_user_id = $2 AND type = 'goal_milestone' AND enabled = false`,
    [workspaceId, goal.created_by],
  );
  const isMuted = muted.rows.length > 0;
  const inserted = await pool.query(
    `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link, dedup_key, read_at)
     VALUES ($1, $2, 'goal_milestone', $3, $4, '/goals', $5, CASE WHEN $6::boolean THEN now() ELSE NULL END)
     ON CONFLICT (workspace_id, recipient_clerk_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
    [workspaceId, goal.created_by, title, body, dedupKey, isMuted],
  );
  if ((inserted.rowCount ?? 0) === 0 || isMuted) return;

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
  checkAndNotifyGoalMilestonesForEntity('task', taskId, workspaceId, workspaceUrl);
}

/**
 * Entity-generic form of checkAndNotifyGoalMilestones — roadmap items count toward goal
 * progress when they go live, so a roadmap status change must re-check milestones too.
 */
export function checkAndNotifyGoalMilestonesForEntity(
  entityType: 'task' | 'roadmap_item',
  entityId: string,
  workspaceId: string,
  workspaceUrl: string,
): void {
  getGoalProgressForEntity(entityType, entityId, workspaceId).then(async (goals) => {
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
    logger.warn({ err, entityType, entityId, workspaceId }, 'checkAndNotifyGoalMilestones failed');
  });
}
