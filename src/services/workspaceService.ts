import { pool } from '../config/db.js';

export interface Workspace {
  id: string;
  name: string;
  clerk_org_id: string;
  plan: string;
  created_at: Date;
  updated_at: Date;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  clerk_user_id: string;
  role: string;
  created_at: Date;
}

export async function getWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const result = await pool.query<Workspace>(
    `SELECT w.id, w.name, w.clerk_org_id, w.plan, w.created_at, w.updated_at
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.clerk_user_id = $1
     ORDER BY w.name`,
    [userId],
  );
  return result.rows;
}

export async function getWorkspaceById(workspaceId: string): Promise<Workspace | null> {
  const result = await pool.query<Workspace>(
    'SELECT id, name, clerk_org_id, plan, created_at, updated_at FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function updateWorkspace(
  workspaceId: string,
  data: { name?: string; plan?: string },
): Promise<Workspace | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(data.name);
  }
  if (data.plan !== undefined) {
    fields.push(`plan = $${i++}`);
    values.push(data.plan);
  }
  if (fields.length === 0) return null;

  values.push(workspaceId);
  const result = await pool.query<Workspace>(
    `UPDATE workspaces SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function getMembersForWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
  const result = await pool.query<WorkspaceMember>(
    'SELECT id, workspace_id, clerk_user_id, role, created_at FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at',
    [workspaceId],
  );
  return result.rows;
}

export async function removeMember(workspaceId: string, memberId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM workspace_members WHERE id = $1 AND workspace_id = $2',
    [memberId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function upsertWorkspaceFromClerk(data: {
  clerkOrgId: string;
  name: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (clerk_org_id, name)
     VALUES ($1, $2)
     ON CONFLICT (clerk_org_id) DO UPDATE SET name = EXCLUDED.name`,
    [data.clerkOrgId, data.name],
  );
}

export async function upsertMemberFromClerk(data: {
  clerkOrgId: string;
  clerkUserId: string;
  role: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, clerk_user_id, role)
     SELECT w.id, $2, $3 FROM workspaces w WHERE w.clerk_org_id = $1
     ON CONFLICT (workspace_id, clerk_user_id) DO UPDATE SET role = EXCLUDED.role`,
    [data.clerkOrgId, data.clerkUserId, data.role],
  );
}

export async function deleteMemberFromClerk(data: {
  clerkOrgId: string;
  clerkUserId: string;
}): Promise<void> {
  await pool.query(
    `DELETE FROM workspace_members
     WHERE clerk_user_id = $2
       AND workspace_id = (SELECT id FROM workspaces WHERE clerk_org_id = $1)`,
    [data.clerkOrgId, data.clerkUserId],
  );
}
