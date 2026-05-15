import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

interface TaskTemplate {
  id: string;
  workspace_id: string;
  name: string;
  title: string;
  description: string | null;
  priority: string;
  tags: string[];
  checklist: { id: string; text: string; done: boolean }[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

const checklistItemSchema = z.object({
  id:   z.string().min(1).max(64),
  text: z.string().min(1).max(500),
  done: z.boolean(),
});

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

const createSchema = z.object({
  name:        z.string().min(1).max(200),
  title:       z.string().min(1).max(500),
  description: z.string().optional(),
  priority:    z.enum(PRIORITIES).optional(),
  tags:        z.array(z.string().max(50)).max(20).optional(),
  checklist:   z.array(checklistItemSchema).max(50).optional(),
});

const updateSchema = createSchema.partial();

// GET /api/task-templates
router.get('/', async (req, res, next) => {
  try {
    const result = await pool.query<TaskTemplate>(
      'SELECT * FROM task_templates WHERE workspace_id = $1 ORDER BY name',
      [req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/task-templates
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, title, description, priority = 'medium', tags = [], checklist = [] } = parsed.data;
    const result = await pool.query<TaskTemplate>(
      `INSERT INTO task_templates (workspace_id, name, title, description, priority, tags, checklist, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.workspace.id, name, title, description ?? null, priority, tags, JSON.stringify(checklist), req.auth.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/task-templates/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    const UPDATABLE = new Set(['name', 'title', 'description', 'priority', 'tags', 'checklist']);
    const fields: string[] = ['updated_at = now()'];
    const values: unknown[] = [];
    let i = 1;

    for (const [key, value] of Object.entries(parsed.data)) {
      if (value !== undefined && UPDATABLE.has(key)) {
        if (key === 'checklist') {
          fields.push(`checklist = $${i++}`);
          values.push(JSON.stringify(value));
        } else {
          fields.push(`${key} = $${i++}`);
          values.push(value);
        }
      }
    }

    values.push(req.params.id, req.workspace.id);
    const result = await pool.query<TaskTemplate>(
      `UPDATE task_templates SET ${fields.join(', ')}
       WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/task-templates/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM task_templates WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Template not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
