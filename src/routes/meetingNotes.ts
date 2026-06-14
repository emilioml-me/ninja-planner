// CRUD for meeting notes linked to sprints or epics
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  title:     z.string().min(1).max(255),
  content:   z.string().max(50000).default(''),
  sprint_id: z.string().uuid().nullable().optional(),
  epic_id:   z.string().uuid().nullable().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/meeting-notes
router.get('/', async (req, res, next) => {
  try {
    const { sprint_id, epic_id } = req.query as Record<string, string | undefined>;
    const conditions = ['workspace_id = $1'];
    const values: unknown[] = [req.workspace.id];
    let i = 2;
    if (sprint_id) { conditions.push(`sprint_id = $${i++}`); values.push(sprint_id); }
    if (epic_id)   { conditions.push(`epic_id = $${i++}`);   values.push(epic_id); }

    const { rows } = await pool.query(
      `SELECT id, title, content, sprint_id, epic_id, created_by, created_at, updated_at
       FROM meeting_notes
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC`,
      values,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/meeting-notes
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { title, content, sprint_id, epic_id } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO meeting_notes (workspace_id, title, content, sprint_id, epic_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [req.workspace.id, title, content, sprint_id ?? null, epic_id ?? null, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/meeting-notes/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM meeting_notes WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/meeting-notes/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const ALLOWED = ['title', 'content', 'sprint_id', 'epic_id'] as const;
    for (const key of ALLOWED) {
      if (key in parsed.data) { fields.push(`${key} = $${i++}`); values.push((parsed.data as Record<string, unknown>)[key] ?? null); }
    }
    if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query(
      `UPDATE meeting_notes SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/meeting-notes/:id  [admin or author]
router.delete('/:id', async (req, res, next) => {
  try {
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    const { rows } = await pool.query(
      'SELECT created_by FROM meeting_notes WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    if (!isAdmin && rows[0].created_by !== req.auth.userId) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    await pool.query('DELETE FROM meeting_notes WHERE id = $1', [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
