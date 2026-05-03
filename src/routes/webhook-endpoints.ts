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

// ─── SSRF protection ──────────────────────────────────────────────────────────
// Reject URLs that would cause the server to call itself or internal services.

const PRIVATE_IP_RE = /^(
  127\.\d+\.\d+\.\d+       | # 127.0.0.0/8 loopback
  10\.\d+\.\d+\.\d+        | # 10.0.0.0/8  RFC-1918
  172\.(1[6-9]|2\d|3[01])\.\d+\.\d+ | # 172.16-31.x  RFC-1918
  192\.168\.\d+\.\d+       | # 192.168.0.0/16 RFC-1918
  169\.254\.\d+\.\d+       | # 169.254.0.0/16 link-local
  ::1$                     | # IPv6 loopback
  fd[0-9a-f]{2}:           | # IPv6 ULA fc00::/7
  0\.0\.0\.0
)$/xi;

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.lan)$/i;

function isSafeWebhookUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (PRIVATE_HOST_RE.test(hostname)) return false;
    if (PRIVATE_IP_RE.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

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
