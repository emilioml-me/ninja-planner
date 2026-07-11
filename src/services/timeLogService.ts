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

// Assigns (or clears, when budgetEntryId is null) which budget entry this time log counts
// toward. Verifies the entry belongs to the same workspace so a log can't be linked cross-tenant.
// Only the log's own author or a workspace admin may do this — otherwise any member could
// repoint someone else's billable time onto an arbitrary budget entry, corrupting its rollup.
export async function setTimeLogBudgetEntry(
  id: string,
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
  const query = isAdmin
    ? `UPDATE time_logs SET budget_entry_id = $1 WHERE id = $2 AND workspace_id = $3 RETURNING *`
    : `UPDATE time_logs SET budget_entry_id = $1 WHERE id = $2 AND workspace_id = $3 AND user_clerk_id = $4 RETURNING *`;
  const params = isAdmin ? [budgetEntryId, id, workspaceId] : [budgetEntryId, id, workspaceId, userClerkId];
  const result = await pool.query<TimeLog>(query, params);
  return result.rows[0] ?? null;
}

export async function deleteTimeLog(
  id: string,
  workspaceId: string,
  userClerkId: string,
  isAdmin: boolean,
): Promise<boolean> {
  // Admins can delete any log; members can only delete their own
  const query = isAdmin
    ? `DELETE FROM time_logs WHERE id = $1 AND workspace_id = $2`
    : `DELETE FROM time_logs WHERE id = $1 AND workspace_id = $2 AND user_clerk_id = $3`;
  const params = isAdmin ? [id, workspaceId] : [id, workspaceId, userClerkId];
  const result = await pool.query(query, params);
  return (result.rowCount ?? 0) > 0;
}
