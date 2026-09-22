import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';

type Queryable = Pick<PoolClient, 'query'>;

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_clerk_id: string | null;
  due_date: string | null;
  start_date: string | null;
  tags: string[];
  position: number;
  created_by: string;
  sprint_id: string | null;
  epic_id: string | null;
  recurrence_rule: string | null;
  story_points: number | null;
  checklist: { id: string; text: string; done: boolean }[];
  spawned_from_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskActivity {
  id: string;
  task_id: string;
  actor_clerk_id: string;
  action: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export interface TaskFilters {
  status?: string;
  priority?: string;
  assignee?: string;
  tag?: string;
  due_before?: string;
  due_after?: string;
}

function buildTaskFilterConditions(workspaceId: string, filters: TaskFilters): { conditions: string[]; values: unknown[] } {
  const conditions: string[] = ['workspace_id = $1', 'deleted_at IS NULL'];
  const values: unknown[] = [workspaceId];
  let i = 2;

  if (filters.status) {
    conditions.push(`status = $${i++}`);
    values.push(filters.status);
  }
  if (filters.priority) {
    conditions.push(`priority = $${i++}`);
    values.push(filters.priority);
  }
  if (filters.assignee) {
    conditions.push(`assignee_clerk_id = $${i++}`);
    values.push(filters.assignee);
  }
  if (filters.tag) {
    conditions.push(`$${i++} = ANY(tags)`);
    values.push(filters.tag);
  }
  if (filters.due_before) {
    conditions.push(`due_date <= $${i++}`);
    values.push(filters.due_before);
  }
  if (filters.due_after) {
    conditions.push(`due_date >= $${i++}`);
    values.push(filters.due_after);
  }
  return { conditions, values };
}

export async function getTasks(
  workspaceId: string,
  filters: TaskFilters,
  limit = 500,
  offset = 0,
): Promise<Task[]> {
  const { conditions, values } = buildTaskFilterConditions(workspaceId, filters);
  let i = values.length + 1;
  values.push(Math.min(limit, 1000), offset);
  const result = await pool.query<Task>(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY position, created_at LIMIT $${i++} OFFSET $${i}`,
    values,
  );
  return result.rows;
}

/** Total number of tasks matching the same filters as getTasks (ignores limit/offset). */
export async function countTasks(workspaceId: string, filters: TaskFilters): Promise<number> {
  const { conditions, values } = buildTaskFilterConditions(workspaceId, filters);
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM tasks WHERE ${conditions.join(' AND ')}`,
    values,
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/** Verifies a sprint_id/epic_id belongs to the given workspace before it's linked to a task. */
export async function assertLinkableToWorkspace(
  table: 'sprints' | 'epics',
  id: string | null | undefined,
  workspaceId: string,
  db: Queryable = pool,
): Promise<void> {
  if (!id) return;
  const result = await db.query(`SELECT id FROM ${table} WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  if (result.rows.length === 0) {
    throw Object.assign(new Error(`Invalid ${table.slice(0, -1)}_id for this workspace`), { status: 400 });
  }
}

export async function createTask(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    assignee_clerk_id?: string | null;
    due_date?: string | null;
    start_date?: string | null;
    tags?: string[];
    position?: number;
    sprint_id?: string | null;
    epic_id?: string | null;
    recurrence_rule?: string | null;
    story_points?: number | null;
    checklist?: { id: string; text: string; done: boolean }[];
    spawned_from_id?: string | null;
  },
  createdBy: string,
  db: Queryable = pool,
): Promise<Task> {
  // Tenant-isolation guard: a sprint/epic ID from another workspace must never be linkable.
  await assertLinkableToWorkspace('sprints', data.sprint_id, workspaceId, db);
  await assertLinkableToWorkspace('epics', data.epic_id, workspaceId, db);

  const result = await db.query<Task>(
    `INSERT INTO tasks
       (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by, sprint_id, epic_id, recurrence_rule, story_points, checklist, spawned_from_id, start_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      workspaceId,
      data.title,
      data.description ?? null,
      data.status ?? 'todo',
      data.priority ?? 'medium',
      data.assignee_clerk_id ?? null,
      data.due_date ?? null,
      data.tags ?? [],
      data.position ?? 0,
      createdBy,
      data.sprint_id ?? null,
      data.epic_id ?? null,
      data.recurrence_rule ?? null,
      data.story_points ?? null,
      JSON.stringify(data.checklist ?? []),
      data.spawned_from_id ?? null,
      data.start_date ?? null,
    ],
  );
  return result.rows[0];
}

export async function getTaskById(
  taskId: string,
  workspaceId: string,
): Promise<{ task: Task; activity: TaskActivity[] } | null> {
  const taskResult = await pool.query<Task>(
    'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [taskId, workspaceId],
  );
  if (taskResult.rows.length === 0) return null;

  const activityResult = await pool.query<TaskActivity>(
    `SELECT ta.* FROM task_activity ta
     JOIN tasks t ON t.id = ta.task_id
     WHERE ta.task_id = $1 AND t.workspace_id = $2
     ORDER BY ta.created_at`,
    [taskId, workspaceId],
  );

  return { task: taskResult.rows[0], activity: activityResult.rows };
}

const TASK_UPDATABLE_COLUMNS = new Set(['title', 'description', 'status', 'priority', 'assignee_clerk_id', 'due_date', 'start_date', 'tags', 'sprint_id', 'epic_id', 'recurrence_rule', 'story_points', 'checklist']);

export async function updateTask(
  taskId: string,
  workspaceId: string,
  data: Partial<Record<string, unknown>> & { sprint_id?: string | null; epic_id?: string | null },
  db: Queryable = pool,
): Promise<Task | null> {
  // Tenant-isolation guard: a sprint/epic ID from another workspace must never be linkable.
  if (data.sprint_id !== undefined) await assertLinkableToWorkspace('sprints', data.sprint_id, workspaceId, db);
  if (data.epic_id !== undefined) await assertLinkableToWorkspace('epics', data.epic_id, workspaceId, db);

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && TASK_UPDATABLE_COLUMNS.has(key)) {
      fields.push(`${key} = $${i++}`);
      values.push(key === 'checklist' ? JSON.stringify(value) : value);
    }
  }
  // due_date changing (cleared, pushed back, or moved up) invalidates any prior
  // task.due_date_passed dispatch, so the due-date-check job can re-evaluate it.
  if (data.due_date !== undefined) {
    fields.push('due_date_passed_notified_at = NULL');
  }
  if (fields.length === 0) return null;

  values.push(taskId, workspaceId);
  const result = await db.query<Task>(
    `UPDATE tasks SET ${fields.join(', ')}
     WHERE id = $${i++} AND workspace_id = $${i} AND deleted_at IS NULL
     RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * Locks the task row, reads its pre-update assignee/status, applies the update, and commits —
 * all in one transaction — so a concurrent PATCH can't read stale "previous" values between
 * this route's SELECT and its UPDATE (which previously fed automations the wrong old status).
 */
export async function updateTaskWithPrevState(
  taskId: string,
  workspaceId: string,
  data: Partial<Record<string, unknown>> & { sprint_id?: string | null; epic_id?: string | null },
): Promise<{ task: Task; prevAssigneeClerkId: string | null; prevStatus: string | null; prevDueDate: string | null } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prevRow = await client.query<{ assignee_clerk_id: string | null; status: string; due_date: string | null }>(
      'SELECT assignee_clerk_id, status, due_date FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [taskId, workspaceId],
    );
    if (prevRow.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const prevAssigneeClerkId = prevRow.rows[0].assignee_clerk_id;
    const prevStatus = prevRow.rows[0].status;
    const prevDueDate = prevRow.rows[0].due_date;

    const task = await updateTask(taskId, workspaceId, data, client);
    await client.query('COMMIT');
    return task ? { task, prevAssigneeClerkId, prevStatus, prevDueDate } : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const ninjaTaskPendingMarker = (taskId: string) => `__pending__:${taskId}`;

/**
 * Atomically claims the "sync to ninja-task" slot for a task using a per-task pending sentinel
 * (unique per task, so it can't collide with the DB-level unique constraint on
 * external_ninja_task_id). Returns true if this call won the race and should proceed to push;
 * false if another concurrent request already claimed or completed the sync. Optional for
 * callers where a duplicate push can't happen (e.g. right after INSERT) — they can go straight
 * to resolveNinjaTaskSync, which also accepts the unclaimed (NULL) state.
 */
export async function claimNinjaTaskSync(taskId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE tasks SET external_ninja_task_id = $1
     WHERE id = $2 AND workspace_id = $3 AND external_ninja_task_id IS NULL`,
    [ninjaTaskPendingMarker(taskId), taskId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolves a sync slot to the real external ID. Matches either an unclaimed (NULL) slot or one
 * claimed by claimNinjaTaskSync for this same task, so it's safe to call whether or not the
 * caller claimed first.
 */
export async function resolveNinjaTaskSync(taskId: string, externalId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET external_ninja_task_id = $1
     WHERE id = $2 AND (external_ninja_task_id IS NULL OR external_ninja_task_id = $3)`,
    [externalId, taskId, ninjaTaskPendingMarker(taskId)],
  );
}

/** Releases a claimed-but-failed sync slot back to NULL so a later attempt can retry. */
export async function releaseNinjaTaskSync(taskId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET external_ninja_task_id = NULL WHERE id = $1 AND external_ninja_task_id = $2`,
    [taskId, ninjaTaskPendingMarker(taskId)],
  );
}

export async function updateTaskPosition(
  taskId: string,
  workspaceId: string,
  position: number,
): Promise<Task | null> {
  const result = await pool.query<Task>(
    `UPDATE tasks SET position = $1, updated_at = now()
     WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL
     RETURNING *`,
    [position, taskId, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function softDeleteTask(taskId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE tasks SET deleted_at = now()
     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [taskId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

// Atomically updates positions (batch or single) + status in one transaction.
// Returns the pre-move status alongside the updated task so the caller can run the status
// transition side effects (runTaskStatusEffects) when a Kanban drag crossed columns.
export async function reorderTaskInTransaction(
  taskId: string,
  workspaceId: string,
  newStatus: string,
  newPosition: number,
  resequence?: Array<{ id: string; position: number }>,
): Promise<{ task: Task; prevStatus: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the moved task first and capture its current status.
    const prevRow = await client.query<{ status: string }>(
      'SELECT status FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [taskId, workspaceId],
    );
    if (prevRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const prevStatus = prevRow.rows[0].status;

    if (resequence && resequence.length > 0) {
      // The API accepts `resequence` as an independent array from any caller — nothing enforces
      // that the moved task (taskId/newPosition) is actually a member of it. The only thing that
      // made this safe was the current frontend always splicing the dragged card in; a future
      // caller that omits it would leave `taskId`'s position stale while its status changes
      // underneath it. Folding taskId/newPosition into the resequence set here (if not already
      // present) makes the invariant hold regardless of what the caller sends.
      const effectiveResequence = resequence.some((r) => r.id === taskId)
        ? resequence
        : [...resequence, { id: taskId, position: newPosition }];

      // Lock every affected row up front, in a stable sorted order, so two concurrent
      // reorders of the same column fully serialize instead of interleaving row-by-row
      // (which previously could leave duplicate `position` values across both writers).
      const sortedIds = [...effectiveResequence.map((r) => r.id)].sort();
      await client.query(
        `SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND workspace_id = $2 ORDER BY id FOR UPDATE`,
        [sortedIds, workspaceId],
      );
      // Bulk update using unnest — one round-trip regardless of list size
      await client.query(
        `UPDATE tasks SET position = u.pos, updated_at = now()
         FROM unnest($1::uuid[], $2::int[]) AS u(id, pos)
         WHERE tasks.id = u.id AND tasks.workspace_id = $3 AND tasks.deleted_at IS NULL`,
        [effectiveResequence.map((r) => r.id), effectiveResequence.map((r) => r.position), workspaceId],
      );
    } else {
      await client.query(
        'UPDATE tasks SET position = $1 WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL',
        [newPosition, taskId, workspaceId],
      );
    }

    const result = await client.query<Task>(
      `UPDATE tasks SET status = $1
       WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL
       RETURNING *`,
      [newStatus, taskId, workspaceId],
    );

    await client.query('COMMIT');
    const task = result.rows[0];
    return task ? { task, prevStatus } : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function logTaskActivity(
  taskId: string,
  actorId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'INSERT INTO task_activity (task_id, actor_clerk_id, action, payload) VALUES ($1, $2, $3, $4)',
    [taskId, actorId, action, payload ?? null],
  );
}

// Pure calendar arithmetic on UTC dates (due_date is a 'YYYY-MM-DD' string; mixing local-time
// setDate/setMonth with a UTC-midnight Date shifted dates by a day in non-UTC timezones).
// `monthly` advances the calendar month and clamps to the last day of the target month, so a
// task due Jan 31 recurs on Feb 28/29 instead of overflowing to Mar 3 (setMonth's behaviour).
function addDaysUtc(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}
function addMonthClampedUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)));
}
const RECURRENCE_ADVANCE: Record<string, (d: Date) => Date> = {
  daily: (d) => addDaysUtc(d, 1),
  weekly: (d) => addDaysUtc(d, 7),
  biweekly: (d) => addDaysUtc(d, 14),
  monthly: (d) => addMonthClampedUtc(d, 1),
};

/** Exported for tests. Next due date for a recurring task completed on `today` (YYYY-MM-DD). */
export function computeNextRecurrenceDate(rule: string, dueDate: string | null, today: string): string | null {
  const advance = RECURRENCE_ADVANCE[rule];
  if (!advance) return null;
  // Bump from the original due date if it's today or later, otherwise from today, so an overdue
  // recurring task doesn't respawn already overdue.
  const baseStr = dueDate && dueDate >= today ? dueDate : today;
  const [y, m, d] = baseStr.slice(0, 10).split('-').map(Number);
  return advance(new Date(Date.UTC(y, m - 1, d))).toISOString().slice(0, 10);
}

/**
 * Spawns a fresh copy of a recurring task when the original is completed.
 * The new task's due_date is bumped by the recurrence interval from the original due_date
 * (or from today if the original due date already passed).
 * Dedup: at most one live successor per task instance — a task that is reopened and completed
 * again (or a retried completion) never spawns a second copy. Previously this was a 2-minute
 * time window, so completing the same instance again later spawned duplicates.
 */
export async function spawnRecurringTask(task: Task): Promise<Task | null> {
  const today = new Date().toISOString().slice(0, 10);
  const newDueDate = task.recurrence_rule
    ? computeNextRecurrenceDate(task.recurrence_rule, task.due_date, today)
    : null;
  if (!newDueDate) {
    logger.warn(
      { taskId: task.id, recurrenceRule: task.recurrence_rule },
      '[taskService] spawnRecurringTask: unrecognized recurrence_rule, skipping spawn',
    );
    return null;
  }

  // Dedup + insert are wrapped in a single transaction with a row-level lock on
  // the parent task to prevent concurrent completions from spawning duplicate copies.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the parent task row so concurrent completions queue here
    await client.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [task.id]);

    const dedupCheck = await client.query<{ id: string }>(
      `SELECT id FROM tasks
       WHERE workspace_id = $1
         AND spawned_from_id = $2
         AND deleted_at IS NULL
       LIMIT 1`,
      [task.workspace_id, task.id],
    );

    if (dedupCheck.rows.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    // Only keep the sprint link if that sprint is still open — respawning into a completed
    // sprint would add scope to a closed sprint's burndown/velocity.
    let sprintId: string | null = null;
    if (task.sprint_id) {
      const sprint = await client.query<{ status: string }>(
        'SELECT status FROM sprints WHERE id = $1 AND workspace_id = $2',
        [task.sprint_id, task.workspace_id],
      );
      if (sprint.rows[0] && sprint.rows[0].status !== 'completed') sprintId = task.sprint_id;
    }

    // Carries over epic_id/sprint_id/story_points/checklist alongside the fields that were
    // already cloned — previously omitted, which silently "escaped" every respawned instance of
    // a recurring task from its epic/sprint, corrupting their progress rollups, and dropped the
    // checklist/points on every recurrence.
    const result = await client.query<Task>(
      `INSERT INTO tasks
         (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by, recurrence_rule, spawned_from_id, epic_id, sprint_id, story_points, checklist)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        task.workspace_id,
        task.title,
        task.description ?? null,
        'todo',
        task.priority,
        task.assignee_clerk_id ?? null,
        newDueDate,
        task.tags ?? [],
        0,
        task.created_by,
        task.recurrence_rule,
        task.id,
        task.epic_id ?? null,
        sprintId,
        task.story_points ?? null,
        // Structure (item text) carries over, but each item's `done` flag must reset — it's
        // workflow-instance-specific. Without this, a task whose checklist was fully checked
        // off as part of completing it (the normal path to marking it 'done') respawns already
        // showing every item finished, even though none of the new instance's work has happened.
        JSON.stringify((task.checklist ?? []).map((item) => ({ ...item, done: false }))),
      ],
    );

    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
