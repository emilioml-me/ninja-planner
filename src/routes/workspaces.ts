import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getWorkspacesForUser,
  getWorkspaceById,
  updateWorkspace,
} from '../services/workspaceService.js';

const router = Router();

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  plan: z.string().min(1).max(50).optional(),
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
router.get('/:id', requireWorkspace, async (req, res, next) => {
  try {
    const workspace = await getWorkspaceById(req.workspace.id);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json(workspace);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/workspaces/:id
router.patch('/:id', requireWorkspace, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const workspace = await updateWorkspace(req.workspace.id, parsed.data);
    if (!workspace) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    res.json(workspace);
  } catch (err) {
    next(err);
  }
});

export default router;
