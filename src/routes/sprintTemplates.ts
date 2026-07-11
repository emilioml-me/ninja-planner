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

const useTemplateSchema = z.object({
  start_date: z.string().date().optional(),
  name:       z.string().min(1).max(255).optional(),
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

// PATCH /api/sprint-templates/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const UPDATABLE = new Set(['name', 'goal', 'duration_days']);
    for (const [k, v] of Object.entries(parsed.data)) {
      if (!UPDATABLE.has(k)) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v ?? null);
    }
    if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query(
      `UPDATE sprint_templates SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
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
    const parsed = useTemplateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { rows: tpl } = await pool.query(
      'SELECT * FROM sprint_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (tpl.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    const t = tpl[0];

    const startDate = parsed.data.start_date ?? new Date().toISOString().split('T')[0];
    const end = new Date(startDate);
    end.setDate(end.getDate() + t.duration_days - 1);
    const endDate = end.toISOString().split('T')[0];

    const name = parsed.data.name ?? t.name;

    const { rows } = await pool.query(
      `INSERT INTO sprints (workspace_id, name, goal, status, start_date, end_date, created_by)
       VALUES ($1,$2,$3,'planning',$4,$5,$6) RETURNING *`,
      [req.workspace.id, name, t.goal, startDate, endDate, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
