import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getRevenue,
  createRevenue,
  updateRevenue,
  deleteRevenue,
} from '../services/revenueService.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  period_type:    z.enum(['monthly', 'quarterly', 'yearly']),
  period_start:   z.string().date(),
  target_amount:  z.number().positive(),
  actual_amount:  z.number().min(0).optional(),
  notes:          z.string().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/revenue
router.get('/', async (req, res, next) => {
  try {
    const targets = await getRevenue(req.workspace.id);
    res.json(targets);
  } catch (err) {
    next(err);
  }
});

// POST /api/revenue
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const target = await createRevenue(req.workspace.id, parsed.data);
    res.status(201).json(target);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/revenue/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const target = await updateRevenue(req.params.id, req.workspace.id, parsed.data);
    if (!target) {
      res.status(404).json({ error: 'Revenue target not found' });
      return;
    }
    res.json(target);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/revenue/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteRevenue(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Revenue target not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
