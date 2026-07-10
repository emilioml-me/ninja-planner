import { pool } from '../config/db.js';

export interface TimeLog {
  id: string;
  task_id: string;
  workspace_id: string;
  user_clerk_id: string;
  minutes: number;
  note: string | null;
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
): Promise<TimeLog> {
  const result = await pool.query<TimeLog>(
    `INSERT INTO time_logs (task_id, workspace_id, user_clerk_id, minutes, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [taskId, workspaceId, userClerkId, minutes, note ?? null],
  );
  return result.rows[0];
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
