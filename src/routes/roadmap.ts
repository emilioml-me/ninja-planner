import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getRoadmap,
  createRoadmapItem,
  updateRoadmapItem,
  deleteRoadmapItem,
} from '../services/roadmapService.js';
import { upsertShareToken, getShareToken, revokeShareToken } from '../services/shareService.js';

const router = Router();
router.use(requireWorkspace);

const STATUSES = ['idea', 'building', 'live', 'archived'] as const;

const createSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().optional(),
  phase:        z.string().max(100).optional(),
  status:       z.enum(STATUSES).optional(),
  priority:     z.number().int().min(0).optional(),
});

const updateSchema = createSchema.partial();

// GET /api/roadmap
router.get('/', async (req, res, next) => {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      phase:  req.query.phase  as string | undefined,
    };
    const items = await getRoadmap(req.workspace.id, filters);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// POST /api/roadmap
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const item = await createRoadmapItem(req.workspace.id, parsed.data);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/roadmap/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    const item = await updateRoadmapItem(req.params.id, req.workspace.id, parsed.data);
    if (!item) {
      res.status(404).json({ error: 'Roadmap item not found' });
      return;
    }
    res.json(item);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/roadmap/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteRoadmapItem(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Roadmap item not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Share token management ───────────────────────────────────────────────────

// GET /api/roadmap/share  — get current token (null if none)
router.get('/share', async (req, res, next) => {
  try {
    const st = await getShareToken(req.workspace.id, 'roadmap');
    res.json({ token: st?.token ?? null });
  } catch (err) { next(err); }
});

// POST /api/roadmap/share  — create or return existing token
router.post('/share', async (req, res, next) => {
  try {
    const st = await upsertShareToken(req.workspace.id, 'roadmap', req.auth.userId);
    res.json({ token: st.token });
  } catch (err) { next(err); }
});

// DELETE /api/roadmap/share  — revoke token
router.delete('/share', async (req, res, next) => {
  try {
    await revokeShareToken(req.workspace.id, 'roadmap');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
