// Project guest links — token-based read-only access
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const VALID_SCOPES = new Set(['tasks:read', 'roadmap:read', 'goals:read', 'sprints:read', 'epics:read', 'changelog:read', 'budgets:read']);

const createSchema = z.object({
  label:      z.string().min(1).max(100).default('Guest Link'),
  scopes:     z.array(z.string()).min(1).refine(
    (s) => s.every((x) => VALID_SCOPES.has(x)),
    { message: 'Invalid scope' },
  ).default(['tasks:read', 'roadmap:read']),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
});

// GET /api/project-shares  [admin]
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, scopes, expires_at, token, created_at
       FROM project_shares WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/project-shares  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { label, scopes, expires_at } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO project_shares (workspace_id, label, scopes, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, label, scopes, expires_at, token, created_at`,
      [req.workspace.id, label, scopes, expires_at ?? null, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/project-shares/:id  [admin]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM project_shares WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
