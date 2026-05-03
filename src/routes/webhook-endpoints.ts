import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getEndpoints,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  getDeliveries,
} from '../services/webhookService.js';

const router = Router();
router.use(requireWorkspace);

const VALID_EVENTS = [
  'task.created', 'task.updated', 'task.completed', 'task.deleted', 'review.submitted',
] as const;

const createSchema = z.object({
  url:    z.string().url().max(2048),
  events: z.array(z.enum(VALID_EVENTS)).default([]),
});

const updateSchema = z.object({
  url:    z.string().url().max(2048).optional(),
  events: z.array(z.enum(VALID_EVENTS)).optional(),
  active: z.boolean().optional(),
});

// GET /api/webhooks
router.get('/', async (req, res, next) => {
  try {
    const endpoints = await getEndpoints(req.workspace.id);
    // Never expose the secret in list responses
    res.json(endpoints.map(({ secret: _s, ...e }) => e));
  } catch (err) { next(err); }
});

// POST /api/webhooks
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const endpoint = await createEndpoint(req.workspace.id, parsed.data, req.auth.userId);
    // Expose secret only on creation so the user can copy it once
    res.status(201).json(endpoint);
  } catch (err) { next(err); }
});

// PATCH /api/webhooks/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const endpoint = await updateEndpoint(req.params.id, req.workspace.id, parsed.data);
    if (!endpoint) { res.status(404).json({ error: 'Endpoint not found' }); return; }
    const { secret: _s, ...safe } = endpoint;
    res.json(safe);
  } catch (err) { next(err); }
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteEndpoint(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Endpoint not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/webhooks/:id/deliveries
router.get('/:id/deliveries', async (req, res, next) => {
  try {
    const deliveries = await getDeliveries(req.params.id, req.workspace.id);
    res.json(deliveries);
  } catch (err) { next(err); }
});

export default router;
