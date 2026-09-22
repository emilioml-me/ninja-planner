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

/**
 * H13: the workspace for the caller's ACTIVE Clerk org (the one requireWorkspace would resolve),
 * or null if no workspace row / membership exists yet for it.
 */
export async function getWorkspaceForOrg(clerkOrgId: string, userId: string): Promise<(Workspace & { role: string }) | null> {
  const result = await pool.query<Workspace & { role: string }>(
    `SELECT w.id, w.name, w.clerk_org_id, w.plan, w.created_at, w.updated_at, wm.role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.clerk_org_id = $1 AND wm.clerk_user_id = $2`,
    [clerkOrgId, userId],
  );
  return result.rows[0] ?? null;
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
    'SELECT id, workspace_id, clerk_user_id, role, created_at FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at LIMIT 500',
    [workspaceId],
  );
  return result.rows;
}

const ADMIN_ROLES = ['org:admin', 'org:owner'];

export async function removeMember(workspaceId: string, clerkUserId: string): Promise<boolean> {
  // Prevent removing the last remaining admin/owner — would permanently lock the
  // workspace out of admin-only routes (billing, webhooks, member management, etc.)
  //
  // Wrapped in a transaction with FOR UPDATE on every admin/owner row in the workspace: without
  // this, two concurrent removals of the workspace's last two admins could each read the
  // pre-delete count (2), both pass the `<= 1` check, and both proceed to delete — leaving zero
  // admins with no in-app recovery path. Locking all admin rows up front serializes concurrent
  // removals against each other so the second call always sees the first's decrement.
  //
  // Filters by clerk_user_id, not the internal `id` surrogate key — every call site (members.ts)
  // passes the target's Clerk user id (matching the convention used by every sibling route in
  // that file, e.g. the role-change PATCH), so filtering by `id` here meant this function's two
  // WHERE clauses never matched a real row and member removal always silently failed with 404.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE clerk_user_id = $1 AND workspace_id = $2 FOR UPDATE',
      [clerkUserId, workspaceId],
    );
    if (target.rows.length === 0) {
      await client.query('COMMIT');
      return false;
    }

    if (ADMIN_ROLES.includes(target.rows[0].role)) {
      // C3b: Postgres rejects FOR UPDATE combined with an aggregate (COUNT(*)), so lock the
      // admin rows themselves and count them client-side.
      const adminRows = await client.query<{ id: string }>(
        `SELECT id FROM workspace_members
         WHERE workspace_id = $1 AND role = ANY($2::text[])
         FOR UPDATE`,
        [workspaceId, ADMIN_ROLES],
      );
      if (adminRows.rows.length <= 1) {
        throw Object.assign(new Error('Cannot remove the last admin of a workspace'), { status: 400 });
      }
    }

    const result = await client.query(
      'DELETE FROM workspace_members WHERE clerk_user_id = $1 AND workspace_id = $2',
      [clerkUserId, workspaceId],
    );

    // C3b: also remove the Clerk org membership - otherwise the user keeps the org claim in their
    // session, and the next organizationMembership.* webhook for them re-inserts the row. Done
    // before COMMIT so a Clerk failure rolls the local delete back (no half-removed member).
    const org = await client.query<{ clerk_org_id: string }>(
      'SELECT clerk_org_id FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (org.rows[0]?.clerk_org_id) {
      await removeClerkOrgMembership(org.rows[0].clerk_org_id, clerkUserId);
    }

    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- Clerk org membership helpers ---------------------------------------------

type ClerkApiErrorLike = { status?: number; errors?: Array<{ code?: string }> };

function clerkErrorCodes(err: unknown): string[] {
  const errors = (err as ClerkApiErrorLike | null)?.errors;
  return Array.isArray(errors) ? errors.map((e) => e?.code ?? '').filter(Boolean) : [];
}

/**
 * Adds the user to the Clerk organization as org:member. Idempotent - an existing membership
 * (Clerk code already_a_member_in_organization) is treated as success. Other failures throw a
 * 502-status error so the caller's transaction rolls back.
 */
export async function ensureClerkOrgMembership(clerkOrgId: string, clerkUserId: string): Promise<void> {
  try {
    await clerkClient.organizations.createOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
      role: 'org:member',
    });
  } catch (err) {
    if (clerkErrorCodes(err).includes('already_a_member_in_organization')) return;
    logger.error({ err, clerkOrgId, clerkUserId }, 'Failed to create Clerk organization membership');
    throw Object.assign(new Error('Could not add you to the organization. Please try again.'), { status: 502 });
  }
}

/** Removes the Clerk org membership. A missing membership (404) is treated as success. */
export async function removeClerkOrgMembership(clerkOrgId: string, clerkUserId: string): Promise<void> {
  try {
    await clerkClient.organizations.deleteOrganizationMembership({
      organizationId: clerkOrgId,
      userId: clerkUserId,
    });
  } catch (err) {
    const status = (err as ClerkApiErrorLike | null)?.status;
    if (status === 404 || clerkErrorCodes(err).includes('resource_not_found')) return;
    logger.error({ err, clerkOrgId, clerkUserId }, 'Failed to delete Clerk organization membership');
    throw Object.assign(new Error('Could not remove the member from the organization. Please try again.'), { status: 502 });
  }
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
  const result = await pool.query(
    `INSERT INTO workspace_members (workspace_id, clerk_user_id, role, display_name, email, avatar_url)
     SELECT w.id, $2, $3, $4, $5, $6 FROM workspaces w WHERE w.clerk_org_id = $1
     ON CONFLICT (workspace_id, clerk_user_id) DO UPDATE
       -- H14: 'viewer' is an app-local restriction Clerk knows nothing about (Clerk still says
       -- org:member), so a membership event must not silently lift it - only a promotion to a
       -- Clerk admin/owner role overrides it.
       SET role         = CASE
                            WHEN workspace_members.role = 'viewer'
                             AND EXCLUDED.role NOT IN ('org:admin', 'org:owner')
                            THEN 'viewer'
                            ELSE EXCLUDED.role
                          END,
           display_name = COALESCE(EXCLUDED.display_name, workspace_members.display_name),
           email        = COALESCE(EXCLUDED.email,        workspace_members.email),
           avatar_url   = COALESCE(EXCLUDED.avatar_url,   workspace_members.avatar_url)`,
    [data.clerkOrgId, data.clerkUserId, data.role, data.display_name ?? null, data.email ?? null, data.avatar_url ?? null],
  );
  // A 0-row insert here always means no `workspaces` row matched clerk_org_id yet — Clerk/svix
  // doesn't guarantee delivery ordering, so `organizationMembership.created` can arrive before
  // `organization.created` lands. Throwing (rather than silently no-oping) makes the webhook
  // route return 500, which svix retries — the alternative was a permanently lost membership
  // with no recovery path since the caller never learns the write did nothing.
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(
      `upsertMemberFromClerk: no workspace found for clerk_org_id=${data.clerkOrgId} (organization.created event may not have landed yet)`,
    );
  }
}

/**
 * Lazily backfill display_name/email/avatar_url for a workspace member.
 * Call fire-and-forget (no await) — never throws.
 */
// L28: per-user retry-after for failed Clerk lookups. requireWorkspace calls this on EVERY
// request while display_name is NULL, so a failing/rate-limited Clerk API would otherwise be hit
// once per request per user. Bounded so a flood of distinct ids can't grow it without limit.
const SYNC_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const SYNC_BACKOFF_MAX_ENTRIES = 5000;
const syncRetryAfter = new Map<string, number>();

export async function syncMemberDisplayName(
  workspaceId: string,
  clerkUserId: string,
): Promise<void> {
  const retryAt = syncRetryAfter.get(clerkUserId);
  if (retryAt !== undefined) {
    if (Date.now() < retryAt) return;
    syncRetryAfter.delete(clerkUserId);
  }
  try {
    const check = await pool.query<{ display_name: string | null }>(
      'SELECT display_name FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [workspaceId, clerkUserId],
    );
    if (!check.rows[0] || check.rows[0].display_name !== null) return; // already populated

    let user: Awaited<ReturnType<typeof clerkClient.users.getUser>>;
    try {
      user = await clerkClient.users.getUser(clerkUserId);
    } catch (err) {
      if (syncRetryAfter.size >= SYNC_BACKOFF_MAX_ENTRIES) {
        const oldest = syncRetryAfter.keys().next().value;
        if (oldest !== undefined) syncRetryAfter.delete(oldest);
      }
      syncRetryAfter.set(clerkUserId, Date.now() + SYNC_FAILURE_BACKOFF_MS);
      throw err;
    }
    // Prefer the user's PRIMARY email - emailAddresses[0] is just the first one added.
    const primaryEmail =
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null;
    const display_name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      primaryEmail ||
      clerkUserId;
    const email      = primaryEmail;
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

/**
 * H14: organization.deleted - revoke access by removing every local membership row for the
 * workspace. The workspace's data itself is intentionally kept (no cascade delete from a webhook);
 * clean-up of orphaned workspaces is an operator decision.
 */
export async function revokeWorkspaceMembershipsForOrg(clerkOrgId: string): Promise<number> {
  const result = await pool.query(
    `DELETE FROM workspace_members
     WHERE workspace_id = (SELECT id FROM workspaces WHERE clerk_org_id = $1)`,
    [clerkOrgId],
  );
  return result.rowCount ?? 0;
}
