import { pool } from '../config/db.js';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';

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
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  created_at: Date;
}

export async function getWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const result = await pool.query<Workspace>(
    `SELECT w.id, w.name, w.clerk_org_id, w.plan, w.created_at, w.updated_at
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.clerk_user_id = $1
     ORDER BY w.name
     LIMIT 100`,
    [userId],
  );
  return result.rows;
}

export async function updateWorkspace(
  workspaceId: string,
  data: { name?: string },
): Promise<Workspace | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${i++}`);
    values.push(data.name);
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
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, clerk_user_id, role, display_name, email, avatar_url)
     SELECT w.id, $2, $3, $4, $5, $6 FROM workspaces w WHERE w.clerk_org_id = $1
     ON CONFLICT (workspace_id, clerk_user_id) DO UPDATE
       SET role         = EXCLUDED.role,
           display_name = COALESCE(EXCLUDED.display_name, workspace_members.display_name),
           email        = COALESCE(EXCLUDED.email,        workspace_members.email),
           avatar_url   = COALESCE(EXCLUDED.avatar_url,   workspace_members.avatar_url)`,
    [data.clerkOrgId, data.clerkUserId, data.role, data.display_name ?? null, data.email ?? null, data.avatar_url ?? null],
  );
}

/**
 * Lazily backfill display_name/email/avatar_url for a workspace member.
 * Call fire-and-forget (no await) — never throws.
 */
export async function syncMemberDisplayName(
  workspaceId: string,
  clerkUserId: string,
): Promise<void> {
  try {
    const check = await pool.query<{ display_name: string | null }>(
      'SELECT display_name FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [workspaceId, clerkUserId],
    );
    if (!check.rows[0] || check.rows[0].display_name !== null) return; // already populated

    const user = await clerkClient.users.getUser(clerkUserId);
    const display_name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.emailAddresses[0]?.emailAddress ||
      clerkUserId;
    const email      = user.emailAddresses[0]?.emailAddress ?? null;
    const avatar_url = user.imageUrl ?? null;

    await pool.query(
      `UPDATE workspace_members
          SET display_name = $1, email = $2, avatar_url = $3
        WHERE workspace_id = $4 AND clerk_user_id = $5`,
      [display_name, email, avatar_url, workspaceId, clerkUserId],
    );
  } catch (err) {
    logger.warn({ err, workspaceId, clerkUserId }, 'syncMemberDisplayName failed (non-fatal)');
  }
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
