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

export async function getTasks(
  workspaceId: string,
  filters: TaskFilters,
  limit = 500,
  offset = 0,
): Promise<Task[]> {
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

  values.push(Math.min(limit, 1000), offset);
  const result = await pool.query<Task>(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY position, created_at LIMIT $${i++} OFFSET $${i}`,
    values,
  );
  return result.rows;
}

/** Verifies a sprint_id/epic_id belongs to the given workspace before it's linked to a task. */
async function assertLinkableToWorkspace(
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
       (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by, sprint_id, epic_id, recurrence_rule, story_points, checklist, spawned_from_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
): Promise<{ task: Task; prevAssigneeClerkId: string | null; prevStatus: string | null } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prevRow = await client.query<{ assignee_clerk_id: string | null; status: string }>(
      'SELECT assignee_clerk_id, status FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [taskId, workspaceId],
    );
    if (prevRow.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const prevAssigneeClerkId = prevRow.rows[0].assignee_clerk_id;
    const prevStatus = prevRow.rows[0].status;

    const task = await updateTask(taskId, workspaceId, data, client);
    await client.query('COMMIT');
    return task ? { task, prevAssigneeClerkId, prevStatus } : null;
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

// Atomically updates positions (batch or single) + status in one transaction
export async function reorderTaskInTransaction(
  taskId: string,
  workspaceId: string,
  newStatus: string,
  newPosition: number,
  resequence?: Array<{ id: string; position: number }>,
): Promise<Task | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (resequence && resequence.length > 0) {
      // Lock every affected row up front, in a stable sorted order, so two concurrent
      // reorders of the same column fully serialize instead of interleaving row-by-row
      // (which previously could leave duplicate `position` values across both writers).
      const sortedIds = [...resequence.map((r) => r.id)].sort();
      await client.query(
        `SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND workspace_id = $2 ORDER BY id FOR UPDATE`,
        [sortedIds, workspaceId],
      );
      // Bulk update using unnest — one round-trip regardless of list size
      await client.query(
        `UPDATE tasks SET position = u.pos, updated_at = now()
         FROM unnest($1::uuid[], $2::int[]) AS u(id, pos)
         WHERE tasks.id = u.id AND tasks.workspace_id = $3 AND tasks.deleted_at IS NULL`,
        [resequence.map((r) => r.id), resequence.map((r) => r.position), workspaceId],
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
    return result.rows[0] ?? null;
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

// `monthly` advances the calendar month rather than adding a fixed day count, so a task due
// on the 31st doesn't drift earlier every few cycles the way a flat 30-day add would.
const RECURRENCE_ADVANCE: Record<string, (d: Date) => void> = {
  daily: (d) => d.setDate(d.getDate() + 1),
  weekly: (d) => d.setDate(d.getDate() + 7),
  biweekly: (d) => d.setDate(d.getDate() + 14),
  monthly: (d) => d.setMonth(d.getMonth() + 1),
};

/**
 * Spawns a fresh copy of a recurring task when the original is completed.
 * The new task's due_date is bumped by the recurrence interval from today
 * (or from the original due_date if it's in the future).
 * Includes a 2-minute dedup window to prevent double-spawn on client retries.
 */
export async function spawnRecurringTask(task: Task): Promise<Task | null> {
  const advance = task.recurrence_rule ? RECURRENCE_ADVANCE[task.recurrence_rule] : undefined;
  if (!advance) {
    logger.warn(
      { taskId: task.id, recurrenceRule: task.recurrence_rule },
      '[taskService] spawnRecurringTask: unrecognized recurrence_rule, skipping spawn',
    );
    return null;
  }
  const base = task.due_date ? new Date(task.due_date) : new Date();
  // If the original due_date has already passed, bump from today instead
  if (base < new Date()) {
    base.setTime(Date.now());
  }
  advance(base);
  const newDueDate = base.toISOString().split('T')[0];

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
         AND created_at >= now() - interval '2 minutes'
       LIMIT 1`,
      [task.workspace_id, task.id],
    );

    if (dedupCheck.rows.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    const result = await client.query<Task>(
      `INSERT INTO tasks
         (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by, recurrence_rule, spawned_from_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
