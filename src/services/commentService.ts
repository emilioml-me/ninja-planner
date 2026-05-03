import { pool } from '../config/db.js';

export interface TaskComment {
  id: string;
  task_id: string;
  author_clerk_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export async function getComments(taskId: string, workspaceId: string): Promise<TaskComment[]> {
  const result = await pool.query<TaskComment>(
    `SELECT tc.*
     FROM task_comments tc
     JOIN tasks t ON t.id = tc.task_id
     WHERE tc.task_id = $1 AND t.workspace_id = $2 AND t.deleted_at IS NULL
     ORDER BY tc.created_at`,
    [taskId, workspaceId],
  );
  return result.rows;
}

export async function createComment(
  taskId: string,
  authorId: string,
  body: string,
): Promise<TaskComment> {
  const result = await pool.query<TaskComment>(
    `INSERT INTO task_comments (task_id, author_clerk_id, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [taskId, authorId, body.trim()],
  );
  return result.rows[0];
}

export async function deleteComment(
  commentId: string,
  authorId: string,
  workspaceId: string,
): Promise<boolean> {
  // Author can only delete their own comment; join through tasks for workspace isolation
  const result = await pool.query(
    `DELETE FROM task_comments tc
     USING tasks t
     WHERE tc.id = $1
       AND tc.author_clerk_id = $2
       AND tc.task_id = t.id
       AND t.workspace_id = $3`,
    [commentId, authorId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface WorkloadRow {
  assignee_clerk_id: string;
  status: string;
  count: number;
}

export async function getWorkload(workspaceId: string): Promise<WorkloadRow[]> {
  const result = await pool.query<WorkloadRow>(
    `SELECT assignee_clerk_id, status, COUNT(*)::int AS count
     FROM tasks
     WHERE workspace_id = $1
       AND deleted_at IS NULL
       AND assignee_clerk_id IS NOT NULL
     GROUP BY assignee_clerk_id, status
     ORDER BY assignee_clerk_id, status`,
    [workspaceId],
  );
  return result.rows;
}
