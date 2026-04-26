import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getClients,
  createClient,
  updateClient,
  deleteClient,
} from '../services/clientService.js';

const router = Router();
router.use(requireWorkspace);

const STAGES = ['prospect', 'proposal', 'active', 'churned'] as const;

const createSchema = z.object({
  name:           z.string().min(1).max(255),
  contact_name:   z.string().max(255).optional(),
  contact_email:  z.string().email().optional(),
  stage:          z.enum(STAGES).optional(),
  mrr:            z.number().min(0).optional(),
  notes:          z.string().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/clients
router.get('/', async (req, res, next) => {
  try {
    const stage = req.query.stage as string | undefined;
    const clients = await getClients(req.workspace.id, stage);
    res.json(clients);
  } catch (err) {
    next(err);
  }
});

// POST /api/clients
router.post('/', async (req, res, next) => {
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

// PATCH /api/clients/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
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

// DELETE /api/clients/:id
router.delete('/:id', async (req, res, next) => {
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
