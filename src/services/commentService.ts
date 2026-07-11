import { pool } from '../config/db.js';

export interface TaskComment {
  id: string;
  task_id: string;
  author_clerk_id: string;
  body: string;
  mentions: string[];
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
  mentions: string[] = [],
): Promise<TaskComment> {
  const result = await pool.query<TaskComment>(
    `INSERT INTO task_comments (task_id, author_clerk_id, body, mentions)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [taskId, authorId, body.trim(), mentions],
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

export interface EpicComment {
  id: string;
  epic_id: string;
  author_clerk_id: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export async function getEpicComments(epicId: string, workspaceId: string): Promise<EpicComment[]> {
  const result = await pool.query<EpicComment>(
    `SELECT ec.*
     FROM epic_comments ec
     JOIN epics e ON e.id = ec.epic_id
     WHERE ec.epic_id = $1 AND e.workspace_id = $2
     ORDER BY ec.created_at`,
    [epicId, workspaceId],
  );
  return result.rows;
}

export async function createEpicComment(
  epicId: string,
  authorId: string,
  body: string,
): Promise<EpicComment> {
  const result = await pool.query<EpicComment>(
    `INSERT INTO epic_comments (epic_id, author_clerk_id, body)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [epicId, authorId, body.trim()],
  );
  return result.rows[0];
}

export async function deleteEpicComment(
  commentId: string,
  authorId: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM epic_comments ec
     USING epics e
     WHERE ec.id = $1
       AND ec.author_clerk_id = $2
       AND ec.epic_id = e.id
       AND e.workspace_id = $3`,
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
