// CRUD for meeting notes linked to sprints or epics
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { assertLinkableToWorkspace } from '../services/taskService.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  title:     z.string().trim().min(1).max(255),
  content:   z.string().max(50000).default(''),
  sprint_id: z.string().uuid().nullable().optional(),
  epic_id:   z.string().uuid().nullable().optional(),
});

const updateSchema = createSchema.partial();

const PREVIEW_CHARS = 500;
const listQuerySchema = z.object({
  sprint_id: z.string().uuid().optional(),
  epic_id:   z.string().uuid().optional(),
  // Paginated so the list no longer returns every note's full content at once. Defaults keep
  // the existing client (which reads the first page, newest first) working unchanged.
  limit:     z.coerce.number().int().min(1).max(200).default(100),
  offset:    z.coerce.number().int().min(0).default(0),
  // preview=1 returns a content excerpt (first PREVIEW_CHARS chars) plus content_truncated;
  // fetch GET /:id for the full text.
  preview:   z.enum(['0', '1', 'true', 'false']).optional(),
});

// GET /api/meeting-notes  -> array; total count in the X-Total-Count header
router.get('/', async (req, res, next) => {
  try {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ error: q.error.flatten() }); return; }
    const { sprint_id, epic_id, limit, offset } = q.data;
    const preview = q.data.preview === '1' || q.data.preview === 'true';

    const conditions = ['workspace_id = $1'];
    const values: unknown[] = [req.workspace.id];
    let i = 2;
    if (sprint_id) { conditions.push(`sprint_id = $${i++}`); values.push(sprint_id); }
    if (epic_id)   { conditions.push(`epic_id = $${i++}`);   values.push(epic_id); }

    const contentCol = preview
      ? `left(content, ${PREVIEW_CHARS}) AS content, char_length(content) > ${PREVIEW_CHARS} AS content_truncated`
      : 'content';
    const { rows } = await pool.query(
      `SELECT id, title, ${contentCol}, sprint_id, epic_id, created_by, created_at, updated_at,
              COUNT(*) OVER()::int AS total_count
       FROM meeting_notes
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      [...values, limit, offset],
    );
    let total = rows.length > 0 ? (rows[0].total_count as number) : 0;
    if (rows.length === 0 && offset > 0) {
      const c = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM meeting_notes WHERE ${conditions.join(' AND ')}`,
        values,
      );
      total = c.rows[0].n;
    }
    res.setHeader('X-Total-Count', String(total));
    res.json(rows.map(({ total_count: _tc, ...r }) => r));
  } catch (err) { next(err); }
});

// POST /api/meeting-notes
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { title, content, sprint_id, epic_id } = parsed.data;

    // Tenant-isolation guard: every other route that accepts a sprint_id/epic_id from the
    // client validates it belongs to the caller's workspace before linking (see
    // taskService.assertLinkableToWorkspace) — this one didn't, so a caller could attach a
    // meeting note to another workspace's sprint/epic id undetected.
    await assertLinkableToWorkspace('sprints', sprint_id, req.workspace.id);
    await assertLinkableToWorkspace('epics', epic_id, req.workspace.id);

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

    // Same rule as DELETE: only the author or a workspace admin may edit a note.
    const existing = await pool.query<{ created_by: string }>(
      'SELECT created_by FROM meeting_notes WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (existing.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    if (!isAdmin && existing.rows[0].created_by !== req.auth.userId) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }

    if (parsed.data.sprint_id !== undefined) await assertLinkableToWorkspace('sprints', parsed.data.sprint_id, req.workspace.id);
    if (parsed.data.epic_id !== undefined) await assertLinkableToWorkspace('epics', parsed.data.epic_id, req.workspace.id);

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const ALLOWED = ['title', 'content', 'sprint_id', 'epic_id'] as const;
    for (const key of ALLOWED) {
      if (!(key in parsed.data)) continue;
      const v = (parsed.data as Record<string, unknown>)[key];
      if (v === undefined) continue;
      // content is NOT NULL: a null means "clear it", i.e. ''.
      fields.push(`${key} = $${i++}`);
      values.push(v ?? (key === 'content' ? '' : null));
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
    await pool.query('DELETE FROM meeting_notes WHERE id = $1 AND workspace_id = $2', [req.params.id, req.workspace.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
