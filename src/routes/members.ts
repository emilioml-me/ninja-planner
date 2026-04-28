import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getMembersForWorkspace, removeMember } from '../services/workspaceService.js';

const router = Router();

// GET /api/workspaces/me/members — current workspace derived from JWT org_id
router.get('/me/members', requireWorkspace, async (req, res, next) => {
  try {
    const members = await getMembersForWorkspace(req.workspace.id);
    res.json(members);
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:id/members
router.get('/:id/members', requireWorkspace, async (req, res, next) => {
  try {
    const members = await getMembersForWorkspace(req.workspace.id);
    res.json(members);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/:id/members/:memberId
router.delete('/:id/members/:memberId', requireWorkspace, async (req, res, next) => {
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

export default router;
