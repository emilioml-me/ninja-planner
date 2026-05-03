import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getGoals, createGoal, updateGoal, deleteGoal,
  getGoalLinks, addGoalLink, removeGoalLink,
} from '../services/goalService.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().optional(),
  due_date:     z.string().date().optional(),
});

const updateSchema = z.object({
  title:        z.string().min(1).max(500).optional(),
  description:  z.string().optional(),
  status:       z.enum(['active', 'completed', 'cancelled']).optional(),
  due_date:     z.string().date().nullable().optional(),
});

const linkSchema = z.object({
  entity_type: z.enum(['task', 'roadmap_item']),
  entity_id:   z.string().uuid(),
});

// GET /api/goals
router.get('/', async (req, res, next) => {
  try {
    res.json(await getGoals(req.workspace.id));
  } catch (err) { next(err); }
});

// POST /api/goals
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    res.status(201).json(await createGoal(req.workspace.id, parsed.data, req.auth.userId));
  } catch (err) { next(err); }
});

// PATCH /api/goals/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const goal = await updateGoal(req.params.id, req.workspace.id, parsed.data);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json(goal);
  } catch (err) { next(err); }
});

// DELETE /api/goals/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteGoal(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/goals/:id/links
router.get('/:id/links', async (req, res, next) => {
  try {
    res.json(await getGoalLinks(req.params.id, req.workspace.id));
  } catch (err) { next(err); }
});

// POST /api/goals/:id/links
router.post('/:id/links', async (req, res, next) => {
  try {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const link = await addGoalLink(req.params.id, req.workspace.id, parsed.data.entity_type, parsed.data.entity_id);
    if (!link) { res.status(409).json({ error: 'Link already exists' }); return; }
    res.status(201).json(link);
  } catch (err) { next(err); }
});

// DELETE /api/goals/:id/links/:entityId
router.delete('/:id/links/:entityId', async (req, res, next) => {
  try {
    const deleted = await removeGoalLink(req.params.id, req.workspace.id, req.params.entityId);
    if (!deleted) { res.status(404).json({ error: 'Link not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
