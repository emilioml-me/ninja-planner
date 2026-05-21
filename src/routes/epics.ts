import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getEpics,
  getEpicById,
  createEpic,
  updateEpic,
  deleteEpic,
} from '../services/epicService.js';
import { fireWebhooks } from '../services/webhookService.js';

const router = Router();
router.use(requireWorkspace);

const EPIC_STATUSES = ['active', 'completed', 'archived'] as const;

const createSchema = z.object({
  title:       z.string().min(1).max(500),
  description: z.string().optional(),
  status:      z.enum(EPIC_STATUSES).optional(),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

const updateSchema = createSchema.partial();

// GET /api/epics
router.get('/', async (req, res, next) => {
  try {
    res.json(await getEpics(req.workspace.id));
  } catch (err) { next(err); }
});

// GET /api/epics/:id
router.get('/:id', async (req, res, next) => {
  try {
    const epic = await getEpicById(req.params.id, req.workspace.id);
    if (!epic) { res.status(404).json({ error: 'Epic not found' }); return; }
    res.json(epic);
  } catch (err) { next(err); }
});

// POST /api/epics  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const epic = await createEpic(req.workspace.id, parsed.data, req.auth.userId);
    fireWebhooks(req.workspace.id, 'task.created', { epic }); // re-use existing event type for now
    res.status(201).json(epic);
  } catch (err) { next(err); }
});

// PATCH /api/epics/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const epic = await updateEpic(req.params.id, req.workspace.id, parsed.data);
    if (!epic) { res.status(404).json({ error: 'Epic not found' }); return; }
    res.json(epic);
  } catch (err) { next(err); }
});

// DELETE /api/epics/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteEpic(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Epic not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
