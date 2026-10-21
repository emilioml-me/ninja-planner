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

/**
 * M11: renames the workspace in Clerk FIRST, then locally. The local row is otherwise reverted by
 * the next organization.updated webhook (Clerk is the source of truth for the org name). A Clerk
 * failure surfaces as a 502 and nothing changes locally; if the local write fails after Clerk
 * accepted the rename, the organization.updated webhook brings the row back in line.
 */
export async function updateWorkspace(
  workspaceId: string,
  data: { name?: string },
): Promise<Workspace | null> {
  if (data.name === undefined) return null;

  const current = await pool.query<{ clerk_org_id: string }>(
    'SELECT clerk_org_id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (current.rows.length === 0) return null;

  try {
    await clerkClient.organizations.updateOrganization(current.rows[0].clerk_org_id, { name: data.name });
  } catch (err) {
    logger.error({ err, workspaceId }, 'Failed to rename Clerk organization');
    throw Object.assign(new Error('Could not rename the workspace. Please try again.'), { status: 502 });
  }

  const result = await pool.query<Workspace>(
    'UPDATE workspaces SET name = $1 WHERE id = $2 RETURNING *',
    [data.name, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function getMembersForWorkspace(workspaceId: string): Promise<WorkspaceMember[]> {
  const result = await pool.query<WorkspaceMember>(
    `SELECT id, workspace_id, clerk_user_id, role, display_name, email, avatar_url, created_at
     FROM workspace_members WHERE workspace_id = $1 ORDER BY created_at LIMIT 500`,
    [workspaceId],
  );
  return result.rows;
}

/**
 * K12/M20: human-readable name for a member, for emails/notifications. Never returns a raw
 * Clerk user id.
 */
export async function getMemberDisplayName(workspaceId: string, clerkUserId: string): Promise<string> {
  try {
    const { rows } = await pool.query<{ display_name: string | null; email: string | null }>(
      'SELECT display_name, email FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [workspaceId, clerkUserId],
    );
    const row = rows[0];
    // syncMemberDisplayName falls back to the Clerk id when a user has no name/email - skip that.
    const name = row?.display_name && row.display_name !== clerkUserId ? row.display_name : null;
    return name || row?.email || 'A teammate';
  } catch (err) {
    logger.warn({ err, workspaceId, clerkUserId }, 'getMemberDisplayName failed');
    return 'A teammate';
  }
}

const ADMIN_ROLES = ['org:admin', 'org:owner'];
const OWNER_ROLE = 'org:owner';

/**
 * Removes a member (locally and from the Clerk org).
 *
 * K25/M12 hierarchy: nobody can remove an org:owner; only an org:owner can remove an admin;
 * admins (and owners) can remove members/viewers. The last admin/owner is never removable.
 *
 * Locking: ONE statement locks the target row plus every admin/owner row of the workspace in id
 * order, so concurrent removals always acquire locks in the same order (the previous
 * target-then-admins sequence deadlocked when two admins were removed at once). The Clerk call is
 * made AFTER commit so no row locks are held across the network round trip; if Clerk fails, the
 * local row is restored (compensating insert) and the error is surfaced.
 *
 * Filters by clerk_user_id (what every call site passes), not the internal surrogate id.
 */
export async function removeMember(
  workspaceId: string,
  clerkUserId: string,
  actorRole?: string | null,
): Promise<boolean> {
  type Row = {
    id: string; clerk_user_id: string; role: string;
    display_name: string | null; email: string | null; avatar_url: string | null; created_at: Date;
  };
  let removedRow: Row | undefined;
  let clerkOrgId: string | null = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const locked = await client.query<Row>(
      `SELECT id, clerk_user_id, role, display_name, email, avatar_url, created_at
       FROM workspace_members
       WHERE workspace_id = $1 AND (clerk_user_id = $2 OR role = ANY($3::text[]))
       ORDER BY id
       FOR UPDATE`,
      [workspaceId, clerkUserId, ADMIN_ROLES],
    );
    const target = locked.rows.find((r) => r.clerk_user_id === clerkUserId);
    if (!target) {
      await client.query('COMMIT');
      return false;
    }

    if (target.role === OWNER_ROLE) {
      throw Object.assign(new Error('The workspace owner cannot be removed'), { status: 403 });
    }
    if (ADMIN_ROLES.includes(target.role)) {
      if (actorRole !== undefined && actorRole !== OWNER_ROLE) {
        throw Object.assign(new Error('Only the workspace owner can remove an admin'), { status: 403 });
      }
      const adminCount = locked.rows.filter((r) => ADMIN_ROLES.includes(r.role)).length;
      if (adminCount <= 1) {
        throw Object.assign(new Error('Cannot remove the last admin of a workspace'), { status: 400 });
      }
    }

    const org = await client.query<{ clerk_org_id: string }>(
      'SELECT clerk_org_id FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    clerkOrgId = org.rows[0]?.clerk_org_id ?? null;

    const result = await client.query(
      'DELETE FROM workspace_members WHERE clerk_user_id = $1 AND workspace_id = $2',
      [clerkUserId, workspaceId],
    );
    if ((result.rowCount ?? 0) > 0) {
      removedRow = target;
      // L28: a departed member must stop receiving watcher notifications.
      await client.query(
        'DELETE FROM task_watchers WHERE workspace_id = $1 AND user_clerk_id = $2',
        [workspaceId, clerkUserId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!removedRow) return false;

  // C3b: also remove the Clerk org membership - otherwise the user keeps the org claim in their
  // session, and the next organizationMembership.* webhook for them re-inserts the row.
  if (clerkOrgId) {
    try {
      await removeClerkOrgMembership(clerkOrgId, clerkUserId);
    } catch (err) {
      // Compensate: put the member back so local state matches Clerk (still a member there).
      await pool.query(
        `INSERT INTO workspace_members (id, workspace_id, clerk_user_id, role, display_name, email, avatar_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT DO NOTHING`,
        [removedRow.id, workspaceId, removedRow.clerk_user_id, removedRow.role,
         removedRow.display_name, removedRow.email, removedRow.avatar_url, removedRow.created_at],
      ).catch((restoreErr) => {
        logger.error({ err: restoreErr, workspaceId, clerkUserId }, 'Failed to restore member after Clerk removal failure');
      });
      throw err;
    }
  }
  return true;
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

/** Thrown by upsertMemberFromClerk when no local workspace row exists for the org yet. */
export class WorkspaceNotFoundError extends Error {
  constructor(clerkOrgId: string) {
    super(`upsertMemberFromClerk: no workspace found for clerk_org_id=${clerkOrgId} (organization.created event may not have landed yet)`);
    this.name = 'WorkspaceNotFoundError';
  }
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
    throw new WorkspaceNotFoundError(data.clerkOrgId);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM workspace_members
       WHERE clerk_user_id = $2
         AND workspace_id = (SELECT id FROM workspaces WHERE clerk_org_id = $1)`,
      [data.clerkOrgId, data.clerkUserId],
    );
    // L28: same transaction - drop the departed member's task watches.
    await client.query(
      `DELETE FROM task_watchers
       WHERE user_clerk_id = $2
         AND workspace_id = (SELECT id FROM workspaces WHERE clerk_org_id = $1)`,
      [data.clerkOrgId, data.clerkUserId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * L18: user.updated - refresh the cached profile columns on every membership row of that user.
 * Returns the number of rows updated.
 */
export async function updateMemberProfileFromClerk(data: {
  clerkUserId: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}): Promise<number> {
  const result = await pool.query(
    `UPDATE workspace_members
        SET display_name = COALESCE($2, display_name),
            email        = COALESCE($3, email),
            avatar_url   = COALESCE($4, avatar_url)
      WHERE clerk_user_id = $1`,
    [data.clerkUserId, data.display_name, data.email, data.avatar_url],
  );
  return result.rowCount ?? 0;
}

export interface WorkspaceDeactivationCounts {
  workspaceFound: boolean;
  members: number;
  apiKeys: number;
  projectShares: number;
  shareTokens: number;
  invites: number;
  webhookEndpoints: number;
  automationRules: number;
}

/**
 * H1/K4: organization.deleted - shut every access path to the workspace, not just Clerk-backed
 * ones: memberships, API keys, guest links (project_shares), public roadmap tokens
 * (share_tokens) and pending invites are removed/revoked; outbound webhooks and automation rules
 * are switched off. The workspace's data itself is intentionally kept (no cascade delete from a
 * webhook); clean-up of orphaned workspaces is an operator decision. One transaction so a partial
 * failure leaves nothing half-revoked (svix retries the whole event).
 */
export async function deactivateWorkspaceForOrg(clerkOrgId: string): Promise<WorkspaceDeactivationCounts> {
  const counts: WorkspaceDeactivationCounts = {
    workspaceFound: false, members: 0, apiKeys: 0, projectShares: 0, shareTokens: 0,
    invites: 0, webhookEndpoints: 0, automationRules: 0,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ws = await client.query<{ id: string }>(
      'SELECT id FROM workspaces WHERE clerk_org_id = $1 FOR UPDATE',
      [clerkOrgId],
    );
    if (ws.rows.length === 0) {
      await client.query('COMMIT');
      return counts;
    }
    const wid = ws.rows[0].id;
    counts.workspaceFound = true;

    const run = async (sql: string): Promise<number> =>
      (await client.query(sql, [wid])).rowCount ?? 0;

    counts.members          = await run('DELETE FROM workspace_members WHERE workspace_id = $1');
    await run('DELETE FROM task_watchers WHERE workspace_id = $1');
    counts.apiKeys          = await run('DELETE FROM api_keys WHERE workspace_id = $1');
    counts.projectShares    = await run('DELETE FROM project_shares WHERE workspace_id = $1');
    counts.shareTokens      = await run('DELETE FROM share_tokens WHERE workspace_id = $1');
    counts.invites          = await run(
      `UPDATE workspace_invites SET used_at = now(), used_by = 'revoked'
       WHERE workspace_id = $1 AND used_at IS NULL`,
    );
    counts.webhookEndpoints = await run('UPDATE webhook_endpoints SET active = false WHERE workspace_id = $1 AND active = true');
    counts.automationRules  = await run('UPDATE automation_rules SET active = false WHERE workspace_id = $1 AND active = true');

    await client.query('COMMIT');
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
