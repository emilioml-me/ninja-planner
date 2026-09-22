import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getWorkspacesForUser,
  getWorkspaceForOrg,
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

// GET /api/workspaces/current — H13: the workspace for the ACTIVE org in the session token
// (what requireWorkspace resolves for every other route). 404 when the workspace row or the
// caller's membership doesn't exist yet (e.g. Clerk webhook still in flight), so the client's
// WorkspaceGate can show its recovery screen instead of rendering an app that 403s everywhere.
router.get('/current', async (req, res, next) => {
  try {
    const orgId = req.auth.orgId;
    if (!orgId || orgId.trim() === '') {
      res.status(403).json({ error: 'No active organization in token' });
      return;
    }
    const workspace = await getWorkspaceForOrg(orgId, req.auth.userId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }
    res.json(workspace);
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

// PATCH /api/workspaces/:id  [admin only — accepts org:admin and org:owner]
router.patch('/:id', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id !== req.workspace.id) {
      res.status(403).json({ error: 'Access denied' });
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
