import { pool } from '../config/db.js';

export interface Task {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_clerk_id: string | null;
  due_date: string | null;
  tags: string[];
  position: number;
  created_by: string;
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

export async function getTasks(workspaceId: string, filters: TaskFilters): Promise<Task[]> {
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

  const result = await pool.query<Task>(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY position, created_at`,
    values,
  );
  return result.rows;
}

export async function createTask(
  workspaceId: string,
  data: {
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    assignee_clerk_id?: string;
    due_date?: string;
    tags?: string[];
    position?: number;
  },
  createdBy: string,
): Promise<Task> {
  const result = await pool.query<Task>(
    `INSERT INTO tasks
       (workspace_id, title, description, status, priority, assignee_clerk_id, due_date, tags, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
    'SELECT * FROM task_activity WHERE task_id = $1 ORDER BY created_at',
    [taskId],
  );

  return { task: taskResult.rows[0], activity: activityResult.rows };
}

export async function updateTask(
  taskId: string,
  workspaceId: string,
  data: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'assignee_clerk_id' | 'due_date' | 'tags'>>,
): Promise<Task | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }
  }
  if (fields.length === 0) return null;

  values.push(taskId, workspaceId);
  const result = await pool.query<Task>(
    `UPDATE tasks SET ${fields.join(', ')}
     WHERE id = $${i++} AND workspace_id = $${i} AND deleted_at IS NULL
     RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function updateTaskPosition(
  taskId: string,
  workspaceId: string,
  position: number,
): Promise<Task | null> {
  const result = await pool.query<Task>(
    `UPDATE tasks SET position = $1
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
