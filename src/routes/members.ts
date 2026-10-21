import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { getMembersForWorkspace, removeMember } from '../services/workspaceService.js';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';
import { pool } from '../config/db.js';
import { getRequestTz, todayInTz } from '../lib/tz.js';

const router = Router();

// ─── Shared: enrich members with display names ────────────────────────────────

// Clerk's getUserList caps `userId` at 100 entries per call — chunk so workspaces larger than
// that still resolve everyone (bounded by getMembersForWorkspace's own LIMIT 500).
const CLERK_LOOKUP_CHUNK_SIZE = 100;

type MemberRow = Awaited<ReturnType<typeof getMembersForWorkspace>>[number];

/**
 * L18: the cached workspace_members columns (kept fresh by the membership + user.updated
 * webhooks and syncMemberDisplayName) are the source; Clerk is only called for rows that have
 * never been populated, and what it returns is written back so the next list is DB-only.
 */
async function enrichMembers(workspaceId: string, members: MemberRow[]) {
  if (members.length === 0) return [];

  const fetched = new Map<string, { display_name: string; email: string | null; image_url: string | null }>();
  const missing = members.filter((m) => !m.display_name);
  if (missing.length > 0) {
    try {
      const chunks: MemberRow[][] = [];
      for (let i = 0; i < missing.length; i += CLERK_LOOKUP_CHUNK_SIZE) {
        chunks.push(missing.slice(i, i + CLERK_LOOKUP_CHUNK_SIZE));
      }
      const results = await Promise.all(
        chunks.map((chunk) =>
          clerkClient.users.getUserList({ userId: chunk.map((m) => m.clerk_user_id), limit: CLERK_LOOKUP_CHUNK_SIZE }),
        ),
      );
      for (const u of results.flatMap((r) => r.data)) {
        const email =
          u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)?.emailAddress ??
          u.emailAddresses[0]?.emailAddress ??
          null;
        const display_name = [u.firstName, u.lastName].filter(Boolean).join(' ') || email;
        if (!display_name) continue;
        fetched.set(u.id, { display_name, email, image_url: u.imageUrl ?? null });
      }
      // Write back so subsequent lists don't hit Clerk again (best-effort).
      await Promise.all(
        [...fetched.entries()].map(([userId, f]) =>
          pool.query(
            `UPDATE workspace_members
                SET display_name = $1, email = COALESCE($2, email), avatar_url = COALESCE($3, avatar_url)
              WHERE workspace_id = $4 AND clerk_user_id = $5 AND display_name IS NULL`,
            [f.display_name, f.email, f.image_url, workspaceId, userId],
          ),
        ),
      ).catch((err) => logger.warn({ err }, 'Failed to cache member profiles'));
    } catch (err) {
      logger.warn({ err }, 'Failed to look up uncached members in Clerk');
    }
  }

  return members.map((m) => {
    const f = fetched.get(m.clerk_user_id);
    return {
      ...m,
      display_name: m.display_name ?? f?.display_name ?? m.email ?? m.clerk_user_id,
      email: m.email ?? f?.email ?? null,
      image_url: m.avatar_url ?? f?.image_url ?? null,
    };
  });
}

// GET /api/workspaces/me/members — workspace resolved from JWT org_id
router.get('/me/members', requireWorkspace, async (req, res, next) => {
  try {
    const raw = await getMembersForWorkspace(req.workspace.id);
    res.json(await enrichMembers(req.workspace.id, raw));
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/me/members/:clerkUserId/stats  — self or admin only
router.get('/me/members/:clerkUserId/stats', requireWorkspace, async (req, res, next) => {
  try {
    const { clerkUserId } = req.params;

    // Unlike role-change/removal, this had no boundary at all — any member could pull any other
    // member's productivity stats just by knowing their Clerk id.
    if (clerkUserId !== req.auth.userId && !ADMIN_ROLES.has(req.auth.memberRole ?? '')) {
      res.status(403).json({ error: 'Can only view your own stats' });
      return;
    }

    // Verify the user is a member of this workspace
    const memberCheck = await pool.query<{ id: string }>(
      `SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2`,
      [req.workspace.id, clerkUserId],
    );
    if (memberCheck.rows.length === 0) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    // L40/K6: "overdue" is relative to the caller's local date, not the DB's UTC CURRENT_DATE.
    const today = todayInTz(getRequestTz(req));

    // Single CTE query: task stats + sprint count (via sprint_id column) + comment count
    const statsResult = await pool.query<{
      total: number; todo: number; in_progress: number; done: number;
      blocked: number; overdue: number; sprint_count: number; comment_count: number;
    }>(
      `WITH task_stats AS (
         SELECT
           COUNT(*)::int                                                              AS total,
           COUNT(*) FILTER (WHERE status = 'todo')::int                              AS todo,
           COUNT(*) FILTER (WHERE status = 'in_progress')::int                       AS in_progress,
           COUNT(*) FILTER (WHERE status = 'done')::int                              AS done,
           COUNT(*) FILTER (WHERE status = 'blocked')::int                           AS blocked,
           COUNT(*) FILTER (WHERE status <> 'done' AND due_date < $3::date)::int     AS overdue,
           COUNT(DISTINCT sprint_id) FILTER (WHERE sprint_id IS NOT NULL)::int       AS sprint_count
         FROM tasks
         WHERE workspace_id = $1 AND assignee_clerk_id = $2 AND deleted_at IS NULL
       ),
       comment_stats AS (
         SELECT COUNT(*)::int AS comment_count
         FROM task_comments tc
         JOIN tasks t ON t.id = tc.task_id
         WHERE t.workspace_id = $1 AND tc.author_clerk_id = $2
       )
       SELECT ts.*, cs.comment_count FROM task_stats ts, comment_stats cs`,
      [req.workspace.id, clerkUserId, today],
    );

    const stats = statsResult.rows[0] ?? {
      total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, overdue: 0, sprint_count: 0, comment_count: 0,
    };
    const completionRate = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    res.json({
      total: stats.total,
      todo: stats.todo,
      in_progress: stats.in_progress,
      done: stats.done,
      blocked: stats.blocked,
      overdue: stats.overdue,
      sprint_count: stats.sprint_count,
      comment_count: stats.comment_count,
      completion_rate: completionRate,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/workspaces/me/members/:memberId/role  [admin only]
// Toggles between 'org:member' and 'viewer' (read-only). Clerk-managed admin/owner roles are
// not settable here — those come from the org's own role sync, not this app.
router.patch('/me/members/:memberId/role', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ role: z.enum(['org:member', 'viewer']) }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const target = await pool.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [req.workspace.id, req.params.memberId],
    );
    if (target.rows.length === 0) { res.status(404).json({ error: 'Member not found' }); return; }
    // K25: admin/owner roles are Clerk-managed (changed in the Clerk org, synced by webhook), so
    // they can't be changed here by anyone - including the owner.
    if (ADMIN_ROLES.has(target.rows[0].role)) {
      res.status(400).json({ error: 'Cannot change role for an admin/owner here' });
      return;
    }

    const result = await pool.query(
      `UPDATE workspace_members SET role = $1
       WHERE workspace_id = $2 AND clerk_user_id = $3
       RETURNING clerk_user_id, role`,
      [parsed.data.role, req.workspace.id, req.params.memberId],
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/workspaces/me/members/:memberId
// K25: owner can't be removed; only the owner removes admins; admins remove members/viewers
// (enforced in removeMember under the row locks).
router.delete('/me/members/:memberId', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const removed = await removeMember(req.workspace.id, req.params.memberId, req.auth.memberRole ?? null);
    if (!removed) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
