import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { getMembersForWorkspace, removeMember } from '../services/workspaceService.js';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';
import { pool } from '../config/db.js';

const router = Router();

// ─── Shared: enrich members with Clerk display names ─────────────────────────

async function enrichMembers(members: Awaited<ReturnType<typeof getMembersForWorkspace>>) {
  if (members.length === 0) return [];
  try {
    const result = await clerkClient.users.getUserList({
      userId: members.map((m) => m.clerk_user_id),
      limit: 100,
    });
    return members.map((m) => {
      const u = result.data.find((u) => u.id === m.clerk_user_id);
      const name = u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') ||
          u.emailAddresses[0]?.emailAddress ||
          m.clerk_user_id
        : m.clerk_user_id;
      return {
        ...m,
        display_name: name,
        image_url: u?.imageUrl ?? null,
      };
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to enrich members with Clerk data — returning raw');
    return members.map((m) => ({ ...m, display_name: m.clerk_user_id, image_url: null }));
  }
}

// GET /api/workspaces/me/members — workspace resolved from JWT org_id
router.get('/me/members', requireWorkspace, async (req, res, next) => {
  try {
    const raw = await getMembersForWorkspace(req.workspace.id);
    res.json(await enrichMembers(raw));
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:id/members
router.get('/:id/members', requireWorkspace, async (req, res, next) => {
  try {
    if (req.params.id !== req.workspace.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const raw = await getMembersForWorkspace(req.workspace.id);
    res.json(await enrichMembers(raw));
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/me/members/:clerkUserId/stats
router.get('/me/members/:clerkUserId/stats', requireWorkspace, async (req, res, next) => {
  try {
    const { clerkUserId } = req.params;

    // Verify the user is a member of this workspace
    const memberCheck = await pool.query<{ id: string }>(
      `SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2`,
      [req.workspace.id, clerkUserId],
    );
    if (memberCheck.rows.length === 0) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

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
           COUNT(*) FILTER (WHERE status <> 'done' AND due_date < CURRENT_DATE)::int AS overdue,
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
      [req.workspace.id, clerkUserId],
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
    if (ADMIN_ROLES.has(target.rows[0].role) || target.rows[0].role === 'guest') {
      res.status(400).json({ error: 'Cannot change role for an admin/owner or guest member here' });
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
router.delete('/me/members/:memberId', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const removed = await removeMember(req.workspace.id, req.params.memberId);
    if (!removed) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:id/members/:memberId
router.delete('/:id/members/:memberId', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id !== req.workspace.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const removed = await removeMember(req.workspace.id, req.params.memberId);
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
