import { pool } from '../config/db.js';

export interface TimeLog {
  id: string;
  task_id: string;
  workspace_id: string;
  user_clerk_id: string;
  minutes: number;
  note: string | null;
  billable: boolean;
  hourly_rate: number | null;
  budget_entry_id: string | null;
  logged_at: string;
  created_at: string;
}

export interface TimeLogWithUser extends TimeLog {
  display_name: string | null;
}

export async function getTimeLogs(taskId: string, workspaceId: string): Promise<TimeLogWithUser[]> {
  const result = await pool.query<TimeLogWithUser>(
    `SELECT tl.*,
            wm.display_name
     FROM   time_logs tl
     LEFT JOIN workspace_members wm
            ON wm.clerk_user_id = tl.user_clerk_id
           AND wm.workspace_id  = tl.workspace_id
     WHERE  tl.task_id      = $1
       AND  tl.workspace_id = $2
     ORDER  BY tl.logged_at DESC`,
    [taskId, workspaceId],
  );
  return result.rows;
}

export async function addTimeLog(
  taskId: string,
  workspaceId: string,
  userClerkId: string,
  minutes: number,
  note?: string,
  billable?: boolean,
  hourlyRate?: number | null,
): Promise<TimeLog> {
  const result = await pool.query<TimeLog>(
    `INSERT INTO time_logs (task_id, workspace_id, user_clerk_id, minutes, note, billable, hourly_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [taskId, workspaceId, userClerkId, minutes, note ?? null, billable ?? false, hourlyRate ?? null],
  );
  return result.rows[0];
}

export interface TimeLogPatch {
  minutes?: number;
  note?: string | null;
  billable?: boolean;
  hourly_rate?: number | null;
}

/**
 * Edit a time log. Members may edit only their own logs; admins may edit any. The caller is
 * responsible for rejecting hourly_rate from non-admins (it drives budget time_cost rollups).
 * Returns null when the log doesn't exist on this task / workspace or isn't the caller's.
 */
export async function updateTimeLog(
  id: string,
  taskId: string,
  workspaceId: string,
  userClerkId: string,
  isAdmin: boolean,
  patch: TimeLogPatch,
): Promise<TimeLog | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.minutes !== undefined)     add('minutes', patch.minutes);
  if (patch.note !== undefined)        add('note', patch.note);
  if (patch.billable !== undefined)    add('billable', patch.billable);
  if (patch.hourly_rate !== undefined) add('hourly_rate', patch.hourly_rate);
  if (sets.length === 0) return null;

  params.push(id, taskId, workspaceId);
  let where = `id = $${params.length - 2} AND task_id = $${params.length - 1} AND workspace_id = $${params.length}`;
  if (!isAdmin) {
    params.push(userClerkId);
    where += ` AND user_clerk_id = $${params.length}`;
  }
  const result = await pool.query<TimeLog>(
    `UPDATE time_logs SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    params,
  );
  return result.rows[0] ?? null;
}

// Assigns (or clears, when budgetEntryId is null) which budget entry this time log counts
// toward. Verifies the entry belongs to the same workspace so a log can't be linked cross-tenant.
// Only the log's own author or a workspace admin may do this — otherwise any member could
// repoint someone else's billable time onto an arbitrary budget entry, corrupting its rollup.
export async function setTimeLogBudgetEntry(
  id: string,
  taskId: string,
  workspaceId: string,
  userClerkId: string,
  isAdmin: boolean,
  budgetEntryId: string | null,
): Promise<TimeLog | null> {
  if (budgetEntryId) {
    const check = await pool.query(
      'SELECT 1 FROM budget_entries WHERE id = $1 AND workspace_id = $2',
      [budgetEntryId, workspaceId],
    );
    if (check.rows.length === 0) return null;
  }
  // task_id is matched too so /tasks/:taskId/time-logs/:id can't act on another task's log.
  const query = isAdmin
    ? `UPDATE time_logs SET budget_entry_id = $1 WHERE id = $2 AND task_id = $3 AND workspace_id = $4 RETURNING *`
    : `UPDATE time_logs SET budget_entry_id = $1 WHERE id = $2 AND task_id = $3 AND workspace_id = $4 AND user_clerk_id = $5 RETURNING *`;
  const params = isAdmin ? [budgetEntryId, id, taskId, workspaceId] : [budgetEntryId, id, taskId, workspaceId, userClerkId];
  const result = await pool.query<TimeLog>(query, params);
  return result.rows[0] ?? null;
}

export async function deleteTimeLog(
  id: string,
  taskId: string,
  workspaceId: string,
  userClerkId: string,
  isAdmin: boolean,
): Promise<boolean> {
  // Admins can delete any log; members can only delete their own
  const query = isAdmin
    ? `DELETE FROM time_logs WHERE id = $1 AND task_id = $2 AND workspace_id = $3`
    : `DELETE FROM time_logs WHERE id = $1 AND task_id = $2 AND workspace_id = $3 AND user_clerk_id = $4`;
  const params = isAdmin ? [id, taskId, workspaceId] : [id, taskId, workspaceId, userClerkId];
  const result = await pool.query(query, params);
  return (result.rowCount ?? 0) > 0;
}
