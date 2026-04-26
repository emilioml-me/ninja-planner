import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getRoadmap,
  createRoadmapItem,
  updateRoadmapItem,
  deleteRoadmapItem,
} from '../services/roadmapService.js';

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

export default router;
