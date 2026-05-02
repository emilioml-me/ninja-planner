import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getWorkspacesForUser,
  updateWorkspace,
} from '../services/workspaceService.js';

const router = Router();

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  // plan is intentionally excluded — plan changes must go through billing
});

// GET /api/workspaces/me
router.get('/me', async (req, res, next) => {
  try {
    const workspaces = await getWorkspacesForUser(req.auth.userId);
    res.json(workspaces);
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/:id
router.get('/:id', requireWorkspace, async (req, res) => {
  if (req.params.id !== req.workspace.id) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  res.json(req.workspace);
});

// PATCH /api/workspaces/:id
router.patch('/:id', requireWorkspace, async (req, res, next) => {
  try {
    if (req.params.id !== req.workspace.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    if (req.auth.memberRole !== 'org:admin') {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    const workspace = await updateWorkspace(req.workspace.id, parsed.data);
    res.json(workspace);
  } catch (err) {
    next(err);
  }
});

export default router;
