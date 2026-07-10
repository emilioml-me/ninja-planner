// Custom field definitions and values for tasks
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const defSchema = z.object({
  name:       z.string().min(1).max(100),
  field_type: z.enum(['text', 'number', 'url', 'date', 'select']),
  options:    z.array(z.string().max(100)).max(50).optional(),
  position:   z.number().int().min(0).optional(),
});

const valueSchema = z.object({
  field_def_id: z.string().uuid(),
  value_text:   z.string().max(2000).nullable().optional(),
  value_number: z.number().nullable().optional(),
  value_date:   z.string().nullable().optional(),
});

// ── Field definitions ─────────────────────────────────────────────────────────

// GET /api/custom-fields
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM custom_field_defs WHERE workspace_id = $1 ORDER BY position, created_at',
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/custom-fields  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = defSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, field_type, options, position } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO custom_field_defs (workspace_id, name, field_type, options, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspace.id, name, field_type, options ?? null, position ?? 0, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Explicit allowlist rather than relying on defSchema.partial() silently stripping unknown
// keys — every sibling route in this codebase uses an explicit Set for this; relying purely on
// Zod's implicit key-stripping is fragile if the schema is ever loosened (e.g. .passthrough()).
const DEF_UPDATABLE = new Set(['name', 'field_type', 'options', 'position']);

// PATCH /api/custom-fields/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = defSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(parsed.data)) {
      if (!DEF_UPDATABLE.has(k)) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v ?? null);
    }
    if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query(
      `UPDATE custom_field_defs SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/custom-fields/:id  [admin]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM custom_field_defs WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── Field values (per task) ────────────────────────────────────────────────────

// GET /api/custom-fields/values/:taskId
router.get('/values/:taskId', async (req, res, next) => {
  try {
    const taskCheck = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [req.params.taskId, req.workspace.id],
    );
    if (taskCheck.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    const { rows } = await pool.query(
      `SELECT cfv.*, cfd.name, cfd.field_type, cfd.options
       FROM custom_field_values cfv
       JOIN custom_field_defs cfd ON cfd.id = cfv.field_def_id
       WHERE cfv.task_id = $1 AND cfv.workspace_id = $2`,
      [req.params.taskId, req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const MAX_VALUES_PER_REQUEST = 100;

// PUT /api/custom-fields/values/:taskId  — upsert one or more values
router.put('/values/:taskId', async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    if (entries.length > MAX_VALUES_PER_REQUEST) {
      res.status(400).json({ error: `Max ${MAX_VALUES_PER_REQUEST} values per request` });
      return;
    }
    const taskCheck = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [req.params.taskId, req.workspace.id],
    );
    if (taskCheck.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    const parsedEntries: z.infer<typeof valueSchema>[] = [];
    for (const entry of entries) {
      const parsed = valueSchema.safeParse(entry);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
      parsedEntries.push(parsed.data);
    }
    if (parsedEntries.length === 0) { res.json([]); return; }

    // One query for all field_def_ids instead of one existence-check per entry.
    const fieldDefIds = [...new Set(parsedEntries.map((e) => e.field_def_id))];
    const defResult = await pool.query<{ id: string }>(
      'SELECT id FROM custom_field_defs WHERE id = ANY($1::uuid[]) AND workspace_id = $2',
      [fieldDefIds, req.workspace.id],
    );
    const validDefIds = new Set(defResult.rows.map((r) => r.id));
    const missing = fieldDefIds.find((id) => !validDefIds.has(id));
    if (missing) { res.status(404).json({ error: `Field ${missing} not found` }); return; }

    // One multi-row upsert instead of one round-trip per entry.
    const columnsPerRow = 6;
    const valueRows = parsedEntries.map((e) => [
      e.field_def_id, req.params.taskId, req.workspace.id,
      e.value_text ?? null, e.value_number ?? null, e.value_date ?? null,
    ]);
    const placeholders = valueRows
      .map((_, r) => `(${Array.from({ length: columnsPerRow }, (_, c) => `$${r * columnsPerRow + c + 1}`).join(',')})`)
      .join(', ');

    const { rows } = await pool.query(
      `INSERT INTO custom_field_values (field_def_id, task_id, workspace_id, value_text, value_number, value_date)
       VALUES ${placeholders}
       ON CONFLICT (field_def_id, task_id) DO UPDATE
         SET value_text = EXCLUDED.value_text,
             value_number = EXCLUDED.value_number,
             value_date = EXCLUDED.value_date,
             updated_at = now()
       RETURNING *`,
      valueRows.flat(),
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
