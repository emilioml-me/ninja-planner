// Sprint templates: save/apply reusable sprint blueprints
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const schema = z.object({
  name:          z.string().min(1).max(255),
  goal:          z.string().max(2000).nullable().optional(),
  duration_days: z.number().int().min(1).max(90).default(14),
});

// GET /api/sprint-templates
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM sprint_templates WHERE workspace_id = $1 ORDER BY created_at DESC',
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/sprint-templates  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, goal, duration_days } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO sprint_templates (workspace_id, name, goal, duration_days, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.workspace.id, name, goal ?? null, duration_days, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/sprint-templates/:id  [admin]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM sprint_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /api/sprint-templates/:id/use  — create a sprint from the template
router.post('/:id/use', requireAdmin, async (req, res, next) => {
  try {
    const { rows: tpl } = await pool.query(
      'SELECT * FROM sprint_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (tpl.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const t = tpl[0];

    const startDate = req.body.start_date ?? new Date().toISOString().split('T')[0];
    const end = new Date(startDate);
    end.setDate(end.getDate() + t.duration_days - 1);
    const endDate = end.toISOString().split('T')[0];

    const name = req.body.name ?? t.name;

    const { rows } = await pool.query(
      `INSERT INTO sprints (workspace_id, name, goal, status, start_date, end_date, created_by)
       VALUES ($1,$2,$3,'planning',$4,$5,$6) RETURNING *`,
      [req.workspace.id, name, t.goal, startDate, endDate, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
