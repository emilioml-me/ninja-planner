import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getMembersForWorkspace, removeMember } from '../services/workspaceService.js';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';

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
