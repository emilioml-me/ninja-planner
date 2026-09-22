import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getClients,
  createClient,
  updateClient,
  deleteClient,
} from '../services/clientService.js';

const router = Router();
router.use(requireWorkspace);

const STAGES = ['prospect', 'proposal', 'active', 'churned'] as const;

const MRR_MAX = 9_999_999_999.99; // clients.mrr is NUMERIC(12,2)
const NOTES_MAX = 10_000;

const createSchema = z.object({
  name:           z.string().trim().min(1).max(255),
  contact_name:   z.string().max(255).optional(),
  contact_email:  z.preprocess((v) => (v === '' ? undefined : v), z.string().email().max(255).optional()),
  stage:          z.enum(STAGES).optional(),
  mrr:            z.number().min(0).max(MRR_MAX).optional(),
  notes:          z.string().max(NOTES_MAX).optional(),
});

// PATCH: optional text fields may be cleared by sending null (or '').
const emptyToNull = (v: unknown) => (v === '' ? null : v);
const updateSchema = z.object({
  name:           z.string().trim().min(1).max(255).optional(),
  contact_name:   z.preprocess(emptyToNull, z.string().max(255).nullable().optional()),
  contact_email:  z.preprocess(emptyToNull, z.string().email().max(255).nullable().optional()),
  stage:          z.enum(STAGES).optional(),
  mrr:            z.number().min(0).max(MRR_MAX).optional(),
  notes:          z.preprocess(emptyToNull, z.string().max(NOTES_MAX).nullable().optional()),
});

// GET /api/clients
router.get('/', async (req, res, next) => {
  try {
    const rawStage = req.query.stage;
    if (rawStage !== undefined && (typeof rawStage !== 'string' || !(STAGES as readonly string[]).includes(rawStage))) {
      res.status(400).json({ error: 'Invalid stage' });
      return;
    }
    const stage = rawStage as string | undefined;
    const clients = await getClients(req.workspace.id, stage);
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

// POST /api/clients  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const client = await createClient(req.workspace.id, parsed.data);
    res.status(201).json(client);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/clients/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.values(parsed.data).every((v) => v === undefined)) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    const client = await updateClient(req.params.id, req.workspace.id, parsed.data);
    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    res.json(client);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/clients/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteClient(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
