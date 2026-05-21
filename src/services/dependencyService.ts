import { pool } from '../config/db.js';

export interface TaskDependency {
  id: string;
  workspace_id: string;
  blocking_task_id: string;
  blocked_task_id: string;
  created_by: string;
  created_at: Date;
}

export interface DependencyTask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export interface TaskDependencies {
  /** Tasks that must be completed BEFORE this task can start */
  blocked_by: DependencyTask[];
  /** Tasks that are WAITING on this task */
  blocks: DependencyTask[];
}

export async function getDependencies(
  taskId: string,
  workspaceId: string,
): Promise<TaskDependencies> {
  const [blockedBy, blocks] = await Promise.all([
    // Tasks this task is blocked by (blocking_task_id → this task)
    pool.query<DependencyTask>(
      `SELECT t.id, t.title, t.status, t.priority
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.blocking_task_id
       WHERE td.blocked_task_id = $1 AND td.workspace_id = $2 AND t.deleted_at IS NULL
       ORDER BY t.created_at`,
      [taskId, workspaceId],
    ),
    // Tasks this task blocks (this task → blocked_task_id)
    pool.query<DependencyTask>(
      `SELECT t.id, t.title, t.status, t.priority
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.blocked_task_id
       WHERE td.blocking_task_id = $1 AND td.workspace_id = $2 AND t.deleted_at IS NULL
       ORDER BY t.created_at`,
      [taskId, workspaceId],
    ),
  ]);
  return {
    blocked_by: blockedBy.rows,
    blocks: blocks.rows,
  };
}

/**
 * Add a dependency: blockingTaskId must finish before blockedTaskId.
 * Returns null if either task doesn't belong to the workspace, or if it would
 * create a cycle (blocked_task already directly blocks blocking_task).
 */
export async function addDependency(
  blockingTaskId: string,
  blockedTaskId: string,
  workspaceId: string,
  createdBy: string,
): Promise<TaskDependency | null> {
  // Verify both tasks belong to workspace
  const check = await pool.query<{ id: string }>(
    `SELECT id FROM tasks WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND deleted_at IS NULL`,
    [[blockingTaskId, blockedTaskId], workspaceId],
  );
  if (check.rows.length < 2) return null;

  // Basic cycle check: prevent A→B if B→A already exists
  const cycle = await pool.query(
    `SELECT id FROM task_dependencies
     WHERE blocking_task_id = $1 AND blocked_task_id = $2 AND workspace_id = $3`,
    [blockedTaskId, blockingTaskId, workspaceId],
  );
  if (cycle.rows.length > 0) return null; // would create direct cycle

  const result = await pool.query<TaskDependency>(
    `INSERT INTO task_dependencies (workspace_id, blocking_task_id, blocked_task_id, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (blocking_task_id, blocked_task_id) DO NOTHING
     RETURNING *`,
    [workspaceId, blockingTaskId, blockedTaskId, createdBy],
  );
  return result.rows[0] ?? null;
}

export async function removeDependency(
  id: string,
  workspaceId: string,
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM task_dependencies WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
