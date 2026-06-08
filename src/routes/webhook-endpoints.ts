import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getEndpoints,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  getDeliveries,
} from '../services/webhookService.js';
import { isSafeWebhookUrl } from '../lib/ssrf.js';

const router = Router();
router.use(requireWorkspace);

const safeUrl = z.string().url().max(2048).refine(isSafeWebhookUrl, {
  message: 'URL must not point to a private or internal address',
});

const VALID_EVENTS = [
  'task.created', 'task.updated', 'task.completed', 'task.deleted', 'review.submitted',
] as const;

const createSchema = z.object({
  url:    safeUrl,
  events: z.array(z.enum(VALID_EVENTS)).default([]),
});

const updateSchema = z.object({
  url:    safeUrl.optional(),
  events: z.array(z.enum(VALID_EVENTS)).optional(),
  active: z.boolean().optional(),
});

// GET /api/webhooks/health  — summary for dashboard widget (must be before /:id)
router.get('/health', async (req, res, next) => {
  try {
    const { pool } = await import('../config/db.js');
    const result = await pool.query<{
      total: number; active: number; last_status: string | null; last_delivered_at: string | null;
    }>(
      `SELECT
         COUNT(we.id)::int                                                                     AS total,
         COUNT(we.id) FILTER (WHERE we.active = true)::int                                    AS active,
         (SELECT wd.status FROM webhook_deliveries wd
          JOIN webhook_endpoints we2 ON we2.id = wd.endpoint_id
          WHERE we2.workspace_id = $1
          ORDER BY wd.created_at DESC LIMIT 1)                                                AS last_status,
         (SELECT wd.delivered_at::text FROM webhook_deliveries wd
          JOIN webhook_endpoints we2 ON we2.id = wd.endpoint_id
          WHERE we2.workspace_id = $1
          ORDER BY wd.created_at DESC LIMIT 1)                                                AS last_delivered_at
       FROM webhook_endpoints we WHERE we.workspace_id = $1`,
      [req.workspace.id],
    );
    res.json(result.rows[0] ?? { total: 0, active: 0, last_status: null, last_delivered_at: null });
  } catch (err) { next(err); }
});

// GET /api/webhooks
router.get('/', async (req, res, next) => {
  try {
    const endpoints = await getEndpoints(req.workspace.id);
    // Never expose the secret in list responses
    res.json(endpoints.map(({ secret: _s, ...e }) => e));
  } catch (err) { next(err); }
});

// POST /api/webhooks  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const endpoint = await createEndpoint(req.workspace.id, parsed.data, req.auth.userId);
    // Expose secret only on creation so the user can copy it once
    res.status(201).json(endpoint);
  } catch (err) { next(err); }
});

// PATCH /api/webhooks/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
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

// DELETE /api/webhooks/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteEndpoint(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Endpoint not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/webhooks/:id/deliveries  [admin only]
router.get('/:id/deliveries', requireAdmin, async (req, res, next) => {
  try {
    const deliveries = await getDeliveries(req.params.id, req.workspace.id);
    res.json(deliveries);
  } catch (err) { next(err); }
});

export default router;
