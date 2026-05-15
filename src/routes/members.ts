import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
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

    const statsResult = await pool.query<{
      total: number; todo: number; in_progress: number; done: number;
      blocked: number; overdue: number;
    }>(
      `SELECT
         COUNT(*)::int                                                            AS total,
         COUNT(*) FILTER (WHERE status = 'todo')::int                            AS todo,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int                     AS in_progress,
         COUNT(*) FILTER (WHERE status = 'done')::int                            AS done,
         COUNT(*) FILTER (WHERE status = 'blocked')::int                         AS blocked,
         COUNT(*) FILTER (
           WHERE status <> 'done' AND due_date < CURRENT_DATE
         )::int                                                                   AS overdue
       FROM tasks
       WHERE workspace_id = $1 AND assignee_clerk_id = $2 AND deleted_at IS NULL`,
      [req.workspace.id, clerkUserId],
    );

    const sprintResult = await pool.query<{ sprint_count: number }>(
      `SELECT COUNT(DISTINCT st.sprint_id)::int AS sprint_count
       FROM sprint_tasks st
       JOIN tasks t ON t.id = st.task_id
       WHERE t.workspace_id = $1 AND t.assignee_clerk_id = $2 AND t.deleted_at IS NULL`,
      [req.workspace.id, clerkUserId],
    );

    const commentResult = await pool.query<{ comment_count: number }>(
      `SELECT COUNT(*)::int AS comment_count
       FROM task_comments tc
       JOIN tasks t ON t.id = tc.task_id
       WHERE t.workspace_id = $1 AND tc.author_clerk_id = $2`,
      [req.workspace.id, clerkUserId],
    );

    const stats = statsResult.rows[0] ?? { total: 0, todo: 0, in_progress: 0, done: 0, blocked: 0, overdue: 0 };
    const completionRate = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

    res.json({
      ...stats,
      sprint_count: sprintResult.rows[0]?.sprint_count ?? 0,
      comment_count: commentResult.rows[0]?.comment_count ?? 0,
      completion_rate: completionRate,
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/me/members/:memberId
router.delete('/me/members/:memberId', requireWorkspace, async (req, res, next) => {
  try {
    if (req.auth.memberRole !== 'org:admin') {
      res.status(403).json({ error: 'Admin access required' });
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

// DELETE /api/workspaces/:id/members/:memberId
router.delete('/:id/members/:memberId', requireWorkspace, async (req, res, next) => {
  try {
    if (req.params.id !== req.workspace.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (req.auth.memberRole !== 'org:admin') {
      res.status(403).json({ error: 'Admin access required' });
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
