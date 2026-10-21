import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { todayInTz } from '../lib/tz.js';

// Used when no request timezone is available (system-driven transitions: automations, webhooks).
const DEFAULT_TZ = 'America/Mexico_City';

type Queryable = Pick<PoolClient, 'query'>;

// Accepted range for task due/start dates. One far-future date (e.g. 9999-12-31) used to turn the
// timeline into a multi-million-day range and freeze the tab.
export const TASK_DATE_MIN = '1900-01-01';
export const TASK_DATE_MAX = '2199-12-31';
export const TASK_DATE_RANGE_MESSAGE = `Date must be between ${TASK_DATE_MIN} and ${TASK_DATE_MAX}`;
/** True when a YYYY-MM-DD string is inside the accepted task date range. */
export function isTaskDateInBounds(d: string): boolean {
  return d >= TASK_DATE_MIN && d <= TASK_DATE_MAX;
}
// Positions are int4 columns; anything larger 500s with 22003 instead of a 400.
export const TASK_POSITION_MAX = 1_000_000_000;

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

const TASK_UPDATABLE_COLUMNS = new Set(['title', 'description', 'status', 'priority', 'assignee_clerk_id', 'due_date', 'start_date', 'tags', 'position', 'sprint_id', 'epic_id', 'recurrence_rule', 'story_points', 'checklist']);

// Canonical form of a column value for "did it actually change" comparisons. Checklist items
// come back from jsonb with reordered keys, so they're compared by their fields, not raw JSON.
function comparableValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (key === 'checklist' && Array.isArray(value)) {
    return JSON.stringify(
      (value as { id: string; text: string; done: boolean }[]).map((item) => [item.id, item.text, Boolean(item.done)]),
    );
  }
  if ((key === 'due_date' || key === 'start_date') && typeof value === 'string') return JSON.stringify(value.slice(0, 10));
  return JSON.stringify(value);
}

/**
 * Returns only the updatable fields of `data` whose value differs from `prev`. A full-object
 * PATCH echoes every field; only the real changes should be written, logged and announced.
 */
export function diffTaskChanges(prev: Task, data: Partial<Record<string, unknown>>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  const prevRecord = prev as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || !TASK_UPDATABLE_COLUMNS.has(key)) continue;
    if (comparableValue(key, value) !== comparableValue(key, prevRecord[key])) changed[key] = value;
  }
  return changed;
}

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
 *
 * Only fields whose value actually differs are written; `changed` lists them (empty when the
 * request was a no-op, in which case the unchanged task is returned and nothing is written, so
 * an echoed due_date doesn't reset the due-date automation marker either).
 */
export async function updateTaskWithPrevState(
  taskId: string,
  workspaceId: string,
  data: Partial<Record<string, unknown>> & { sprint_id?: string | null; epic_id?: string | null },
): Promise<{
  task: Task;
  prevAssigneeClerkId: string | null;
  prevStatus: string | null;
  prevDueDate: string | null;
  changed: Record<string, unknown>;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prevRow = await client.query<Task>(
      'SELECT * FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL FOR UPDATE',
      [taskId, workspaceId],
    );
    if (prevRow.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }
    const prev = prevRow.rows[0];
    const changed = diffTaskChanges(prev, data);

    let task: Task | null = prev;
    if (Object.keys(changed).length > 0) {
      task = await updateTask(taskId, workspaceId, changed, client);
    }
    await client.query('COMMIT');
    return task
      ? { task, prevAssigneeClerkId: prev.assignee_clerk_id, prevStatus: prev.status, prevDueDate: prev.due_date, changed }
      : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pending sentinel: `__pending__:<taskId>:<claimedAtMs>`. The legacy form without the timestamp
// (`__pending__:<taskId>`) is still recognized. A claim older than NINJA_TASK_CLAIM_STALE_MS is
// considered abandoned (process crashed between claim and resolve) and can be re-claimed, so a
// crash no longer leaves the task permanently unsynced.
const ninjaTaskPendingPrefix = (taskId: string) => `__pending__:${taskId}`;
const NINJA_TASK_CLAIM_STALE_MS = 10 * 60_000;

/**
 * Atomically claims the "sync to ninja-task" slot for a task using a per-task pending sentinel
 * (unique per task, so it can't collide with the DB-level unique constraint on
 * external_ninja_task_id). Returns true if this call won the race and should proceed to push;
 * false if another concurrent request already claimed (recently) or completed the sync. Optional
 * for callers where a duplicate push can't happen (e.g. right after INSERT) — they can go
 * straight to resolveNinjaTaskSync, which also accepts the unclaimed (NULL) state.
 */
export async function claimNinjaTaskSync(taskId: string, workspaceId: string): Promise<boolean> {
  const prefix = ninjaTaskPendingPrefix(taskId);
  const now = Date.now();
  const result = await pool.query(
    `UPDATE tasks SET external_ninja_task_id = $1
     WHERE id = $2 AND workspace_id = $3
       AND (
         external_ninja_task_id IS NULL
         OR external_ninja_task_id = $4
         OR (
           left(external_ninja_task_id, length($4) + 1) = $4 || ':'
           AND (CASE WHEN split_part(external_ninja_task_id, ':', 3) ~ '^[0-9]{1,15}$'
                     THEN split_part(external_ninja_task_id, ':', 3)::bigint ELSE 0 END) < $5
         )
       )`,
    [`${prefix}:${now}`, taskId, workspaceId, prefix, now - NINJA_TASK_CLAIM_STALE_MS],
  );
  return (result.rowCount ?? 0) > 0;
}

// SQL predicate matching any pending sentinel (legacy or timestamped); `param` holds the prefix.
const pendingMarkerMatch = (param: string) =>
  `(external_ninja_task_id = ${param} OR left(external_ninja_task_id, length(${param}) + 1) = ${param} || ':')`;

/**
 * Resolves a sync slot to the real external ID. Matches either an unclaimed (NULL) slot or one
 * claimed by claimNinjaTaskSync for this same task, so it's safe to call whether or not the
 * caller claimed first.
 */
export async function resolveNinjaTaskSync(taskId: string, externalId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET external_ninja_task_id = $1
     WHERE id = $2 AND (external_ninja_task_id IS NULL OR ${pendingMarkerMatch('$3')})`,
    [externalId, taskId, ninjaTaskPendingPrefix(taskId)],
  );
}

/** Releases a claimed-but-failed sync slot back to NULL so a later attempt can retry. */
export async function releaseNinjaTaskSync(taskId: string): Promise<void> {
  await pool.query(
    `UPDATE tasks SET external_ninja_task_id = NULL WHERE id = $1 AND ${pendingMarkerMatch('$2')}`,
    [taskId, ninjaTaskPendingPrefix(taskId)],
  );
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

    // Lock the moved task AND every resequenced row in one statement, in a stable sorted order.
    // Locking the moved row first and the sorted set second let two concurrent drags in the same
    // column each hold one row the other needed (deadlock -> 40P01, drag lost).
    const lockIds = [...new Set([taskId, ...(resequence ?? []).map((r) => r.id)])].sort();
    const locked = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM tasks
       WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND deleted_at IS NULL
       ORDER BY id FOR UPDATE`,
      [lockIds, workspaceId],
    );
    const movedRow = locked.rows.find((r) => r.id === taskId);
    if (!movedRow) {
      await client.query('ROLLBACK');
      return null;
    }
    const prevStatus = movedRow.status;

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

      // Every affected row is already locked above, so two concurrent reorders of the same
      // column fully serialize instead of interleaving row-by-row.
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

function parseDateUtc(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Exported for tests. Next start date for a recurring task: keeps the original start->due span
 * (start moves with the due date); without a due date the start advances on its own.
 */
export function computeNextStartDate(
  rule: string,
  startDate: string | null,
  dueDate: string | null,
  newDueDate: string,
  today: string,
): string | null {
  if (!startDate) return null;
  if (dueDate) {
    const spanDays = Math.round((parseDateUtc(dueDate).getTime() - parseDateUtc(startDate).getTime()) / 86_400_000);
    return addDaysUtc(parseDateUtc(newDueDate), -spanDays).toISOString().slice(0, 10);
  }
  return computeNextRecurrenceDate(rule, startDate, today);
}

/**
 * Spawns a fresh copy of a recurring task when the original is completed.
 * The new task's due_date is bumped by the recurrence interval from the original due_date
 * (or from today if the original due date already passed).
 * Dedup: at most one live successor per task instance — a task that is reopened and completed
 * again (or a retried completion) never spawns a second copy. Previously this was a 2-minute
 * time window, so completing the same instance again later spawned duplicates.
 * `tz` (IANA name) decides what "today" is; defaults to the app's home timezone for
 * system-driven completions with no request context.
 */
export async function spawnRecurringTask(task: Task, tz: string = DEFAULT_TZ): Promise<Task | null> {
  const today = todayInTz(tz);
  const newDueDate = task.recurrence_rule
    ? computeNextRecurrenceDate(task.recurrence_rule, task.due_date, today)
    : null;
  const newStartDate = task.recurrence_rule && newDueDate
    ? computeNextStartDate(task.recurrence_rule, task.start_date, task.due_date, newDueDate, today)
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
         (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by, recurrence_rule, spawned_from_id, epic_id, sprint_id, story_points, checklist, start_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
        newStartDate,
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
