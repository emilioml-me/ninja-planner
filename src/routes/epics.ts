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
import { dispatchAutomations } from '../services/automationService.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const EPIC_STATUSES = ['active', 'completed', 'archived'] as const;

// Mirrors roadmap.ts's httpUrlSchema — z.string().url() alone accepts javascript: URIs, which
// would be a stored-XSS vector once rendered as a clickable <a href> the same way Roadmap's
// external_ref is.
const httpUrlSchema = z.string().max(500).refine(
  (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } },
  { message: 'external_ref must be a valid http(s) URL' },
);

const createSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().optional(),
  status:       z.enum(EPIC_STATUSES).optional(),
  color:        z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  external_ref: httpUrlSchema.or(z.literal('')).nullable().optional(),
});

const updateSchema = createSchema.partial();

const retroSchema = z.object({
  went_well:    z.string().max(5000).optional(),
  to_improve:   z.string().max(5000).optional(),
  action_items: z.string().max(5000).optional(),
});

// GET /api/epics?status=active|completed|archived
router.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    res.json(await getEpics(req.workspace.id, status));
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
    const epic = await createEpic(
      req.workspace.id,
      { ...parsed.data, external_ref: parsed.data.external_ref || null },
      req.auth.userId,
    );
    fireWebhooks(req.workspace.id, 'epic.created', { epic });
    res.status(201).json(epic);
  } catch (err) { next(err); }
});

// PATCH /api/epics/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const data = { ...parsed.data };
    if (data.external_ref !== undefined) data.external_ref = data.external_ref || null;
    const epic = await updateEpic(req.params.id, req.workspace.id, data);
    if (!epic) { res.status(404).json({ error: 'Epic not found' }); return; }
    fireWebhooks(req.workspace.id, 'epic.updated', { epic });
    if (parsed.data.status === 'completed') {
      dispatchAutomations({
        type: 'epic.completed',
        workspaceId: req.workspace.id,
        epicId: epic.id,
        title: epic.title,
      }).catch(() => {});
    }
    res.json(epic);
  } catch (err) { next(err); }
});

// DELETE /api/epics/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteEpic(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Epic not found' }); return; }
    fireWebhooks(req.workspace.id, 'epic.deleted', { epicId: req.params.id });
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/epics/:id/retro
router.get('/:id/retro', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT er.* FROM epic_retros er
       JOIN epics e ON e.id = er.epic_id
       WHERE er.epic_id = $1 AND e.workspace_id = $2`,
      [req.params.id, req.workspace.id],
    );
    res.json(result.rows[0] ?? null);
  } catch (err) { next(err); }
});

// PUT /api/epics/:id/retro  — upsert (admin only)
router.put('/:id/retro', requireAdmin, async (req, res, next) => {
  try {
    const parsed = retroSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const epicCheck = await pool.query(
      'SELECT id FROM epics WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (epicCheck.rows.length === 0) { res.status(404).json({ error: 'Epic not found' }); return; }

    const { went_well, to_improve, action_items } = parsed.data;
    const result = await pool.query(
      `INSERT INTO epic_retros (epic_id, workspace_id, went_well, to_improve, action_items, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (epic_id) DO UPDATE SET
         went_well    = EXCLUDED.went_well,
         to_improve   = EXCLUDED.to_improve,
         action_items = EXCLUDED.action_items,
         updated_at   = now()
       RETURNING *`,
      [req.params.id, req.workspace.id, went_well ?? null, to_improve ?? null, action_items ?? null, req.auth.userId],
    );
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

export default router;
