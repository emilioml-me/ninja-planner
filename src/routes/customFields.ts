// Custom field definitions and values for tasks
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const defSchema = z.object({
  name:        z.string().min(1).max(100),
  field_type:  z.enum(['text', 'number', 'url', 'date', 'select']),
  entity_type: z.enum(['task', 'client']).default('task'),
  options:     z.array(z.string().max(100)).max(50).optional(),
  position:    z.number().int().min(0).optional(),
});

const valueSchema = z.object({
  field_def_id: z.string().uuid(),
  value_text:   z.string().max(2000).nullable().optional(),
  value_number: z.number().finite().nullable().optional(),
  value_date:   z.string().date().nullable().optional(),
});

type ValueEntry = z.infer<typeof valueSchema>;
type FieldDefRow = { id: string; field_type: string; options: string[] | null };
type NormalizedValue = { field_def_id: string; value_text: string | null; value_number: number | null; value_date: string | null };

const VALUE_COLUMN: Record<string, 'value_text' | 'value_number' | 'value_date'> = {
  text: 'value_text', url: 'value_text', select: 'value_text',
  number: 'value_number', date: 'value_date',
};

/**
 * Dedupes entries by field_def_id (last one wins - a multi-row upsert with the same conflict key
 * twice would fail with "ON CONFLICT DO UPDATE command cannot affect row a second time") and
 * validates each value against its field definition's type, keeping only the column that type
 * uses. Returns an error message string on the first invalid value (including a non-null value in
 * a column the type doesn't use). Callers send only the fields they changed; fields not sent are
 * left untouched.
 */
function normalizeValues(entries: ValueEntry[], defs: Map<string, FieldDefRow>): NormalizedValue[] | string {
  const byDef = new Map<string, ValueEntry>();
  for (const e of entries) byDef.set(e.field_def_id, e);

  const out: NormalizedValue[] = [];
  for (const e of byDef.values()) {
    const def = defs.get(e.field_def_id)!;
    // A value in a column the field type doesn't use is a client bug - reject it rather than
    // silently storing null (which would wipe the field).
    const column = VALUE_COLUMN[def.field_type] ?? 'value_text';
    for (const other of ['value_text', 'value_number', 'value_date'] as const) {
      if (other !== column && e[other] != null) {
        return `Field ${e.field_def_id}: a ${def.field_type} field takes ${column}, not ${other}`;
      }
    }
    const row: NormalizedValue = { field_def_id: e.field_def_id, value_text: null, value_number: null, value_date: null };
    switch (def.field_type) {
      case 'number':
        row.value_number = e.value_number ?? null;
        break;
      case 'date':
        row.value_date = e.value_date ?? null;
        break;
      case 'url': {
        const v = e.value_text?.trim() || null;
        if (v !== null) {
          let ok = false;
          try { const u = new URL(v); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { ok = false; }
          if (!ok) return `Field ${e.field_def_id}: value must be an http(s) URL`;
        }
        row.value_text = v;
        break;
      }
      case 'select': {
        const v = e.value_text ?? null;
        if (v !== null && v !== '' && !(def.options ?? []).includes(v)) {
          return `Field ${e.field_def_id}: value must be one of the field's options`;
        }
        row.value_text = v === '' ? null : v;
        break;
      }
      default: // text
        row.value_text = e.value_text ?? null;
    }
    out.push(row);
  }
  return out;
}

// ── Field definitions ─────────────────────────────────────────────────────────

// GET /api/custom-fields?entity_type=task|client
router.get('/', async (req, res, next) => {
  try {
    const rawEntityType = req.query.entity_type;
    if (rawEntityType !== undefined && rawEntityType !== 'task' && rawEntityType !== 'client') {
      res.status(400).json({ error: 'entity_type must be task or client' });
      return;
    }
    const entityType = rawEntityType as string | undefined;
    const conditions = ['workspace_id = $1'];
    const values: unknown[] = [req.workspace.id];
    if (entityType) { conditions.push(`entity_type = $${values.length + 1}`); values.push(entityType); }

    const { rows } = await pool.query(
      `SELECT * FROM custom_field_defs WHERE ${conditions.join(' AND ')} ORDER BY position, created_at`,
      values,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/custom-fields  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = defSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, field_type, entity_type, options, position } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO custom_field_defs (workspace_id, name, field_type, entity_type, options, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.workspace.id, name, field_type, entity_type, options ?? null, position ?? 0, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// Explicit allowlist rather than relying on defSchema.partial() silently stripping unknown
// keys — every sibling route in this codebase uses an explicit Set for this; relying purely on
// Zod's implicit key-stripping is fragile if the schema is ever loosened (e.g. .passthrough()).
// entity_type is deliberately excluded — changing which entity a definition applies to after
// values have already been recorded against it would orphan those values' semantics.
const DEF_UPDATABLE = new Set(['name', 'field_type', 'options', 'position']);

// entity_type has a default in defSchema; omit it so a PATCH never injects 'task'.
const defPatchSchema = defSchema.omit({ entity_type: true }).partial().extend({
  clear_invalid_values: z.boolean().optional(),
});

// PATCH /api/custom-fields/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = defPatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { clear_invalid_values: clearInvalid, ...patch } = parsed.data;

    // Changing field_type once values exist would leave them stored in the wrong column /
    // failing the new type's rules, so it is only allowed on a field with no values yet.
    // Changing a select field's options must not strand stored values on a removed option: that
    // 409s (with the count) unless clear_invalid_values is set, in which case those values are
    // cleared in the same transaction as the definition update.
    let current: { field_type: string; has_values: boolean } | undefined;
    if (patch.field_type !== undefined || patch.options !== undefined) {
      const result = await pool.query<{ field_type: string; has_values: boolean }>(
        `SELECT field_type,
                EXISTS (SELECT 1 FROM custom_field_values v WHERE v.field_def_id = d.id) AS has_values
         FROM custom_field_defs d WHERE d.id = $1 AND d.workspace_id = $2`,
        [req.params.id, req.workspace.id],
      );
      current = result.rows[0];
      if (!current) { res.status(404).json({ error: 'Not found' }); return; }
      if (patch.field_type !== undefined && current.field_type !== patch.field_type && current.has_values) {
        res.status(409).json({ error: 'Cannot change the type of a field that already has values' });
        return;
      }
    }
    const newType = patch.field_type ?? current?.field_type;
    const checkOptions = patch.options !== undefined && newType === 'select' && current?.has_values;
    if (checkOptions && !clearInvalid) {
      const stranded = await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM custom_field_values
         WHERE field_def_id = $1 AND workspace_id = $2 AND value_text IS NOT NULL
           AND NOT (value_text = ANY($3::text[]))`,
        [req.params.id, req.workspace.id, patch.options ?? []],
      );
      const n = stranded.rows[0]?.n ?? 0;
      if (n > 0) {
        res.status(409).json({
          error: `${n} stored value(s) use an option that would be removed. Resend with clear_invalid_values: true to clear them.`,
          stranded_values: n,
        });
        return;
      }
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      if (!DEF_UPDATABLE.has(k)) continue;
      fields.push(`${k} = $${i++}`);
      values.push(v ?? null);
    }
    if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    values.push(req.params.id, req.workspace.id);

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      const { rows } = await db.query(
        `UPDATE custom_field_defs SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
        values,
      );
      if (rows.length === 0) {
        await db.query('ROLLBACK');
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (checkOptions && clearInvalid) {
        await db.query(
          `UPDATE custom_field_values SET value_text = NULL, updated_at = now()
           WHERE field_def_id = $1 AND workspace_id = $2 AND value_text IS NOT NULL
             AND NOT (value_text = ANY($3::text[]))`,
          [req.params.id, req.workspace.id, patch.options ?? []],
        );
      }
      await db.query('COMMIT');
      res.json(rows[0]);
    } catch (txErr) {
      await db.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      db.release();
    }
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
       WHERE cfv.task_id = $1 AND cfv.workspace_id = $2 AND cfd.entity_type = 'task'`,
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

    const parsedEntries: ValueEntry[] = [];
    for (const entry of entries) {
      const parsed = valueSchema.safeParse(entry);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
      parsedEntries.push(parsed.data);
    }
    if (parsedEntries.length === 0) { res.json([]); return; }

    // One query for all field_def_ids instead of one existence-check per entry.
    // entity_type = 'task' matters here: without it, a 'client'-type field definition's id
    // could be attached to a task's values, corrupting the entity-type invariant (the
    // client-scoped value routes below correctly filter by entity_type = 'client' — this was
    // the one write path that didn't apply the equivalent filter).
    const fieldDefIds = [...new Set(parsedEntries.map((e) => e.field_def_id))];
    const defResult = await pool.query<FieldDefRow>(
      `SELECT id, field_type, options FROM custom_field_defs WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND entity_type = 'task'`,
      [fieldDefIds, req.workspace.id],
    );
    const defs = new Map(defResult.rows.map((r) => [r.id, r]));
    // Values for a field deleted since the client loaded its definitions are dropped instead of
    // failing the whole save (the other fields' edits still land).
    const knownEntries = parsedEntries.filter((e) => defs.has(e.field_def_id));
    if (knownEntries.length === 0) { res.json([]); return; }
    const normalized = normalizeValues(knownEntries, defs);
    if (typeof normalized === 'string') { res.status(400).json({ error: normalized }); return; }

    // One multi-row upsert instead of one round-trip per entry.
    const columnsPerRow = 6;
    const valueRows = normalized.map((e) => [
      e.field_def_id, req.params.taskId, req.workspace.id,
      e.value_text, e.value_number, e.value_date,
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

// ── Field values (per client) ───────────────────────────────────────────────────
// Mirrors the task routes above exactly; clients are the first non-task entity to get
// custom fields, using the client_id column added alongside task_id in migration 041.

// GET /api/custom-fields/values/client/:clientId
router.get('/values/client/:clientId', async (req, res, next) => {
  try {
    const clientCheck = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND workspace_id = $2',
      [req.params.clientId, req.workspace.id],
    );
    if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

    const { rows } = await pool.query(
      `SELECT cfv.*, cfd.name, cfd.field_type, cfd.options
       FROM custom_field_values cfv
       JOIN custom_field_defs cfd ON cfd.id = cfv.field_def_id
       WHERE cfv.client_id = $1 AND cfv.workspace_id = $2 AND cfd.entity_type = 'client'`,
      [req.params.clientId, req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/custom-fields/values/client/:clientId  — upsert one or more values
router.put('/values/client/:clientId', async (req, res, next) => {
  try {
    const entries = Array.isArray(req.body) ? req.body : [req.body];
    if (entries.length > MAX_VALUES_PER_REQUEST) {
      res.status(400).json({ error: `Max ${MAX_VALUES_PER_REQUEST} values per request` });
      return;
    }
    const clientCheck = await pool.query(
      'SELECT id FROM clients WHERE id = $1 AND workspace_id = $2',
      [req.params.clientId, req.workspace.id],
    );
    if (clientCheck.rows.length === 0) { res.status(404).json({ error: 'Client not found' }); return; }

    const parsedEntries: ValueEntry[] = [];
    for (const entry of entries) {
      const parsed = valueSchema.safeParse(entry);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
      parsedEntries.push(parsed.data);
    }
    if (parsedEntries.length === 0) { res.json([]); return; }

    const fieldDefIds = [...new Set(parsedEntries.map((e) => e.field_def_id))];
    const defResult = await pool.query<FieldDefRow>(
      `SELECT id, field_type, options FROM custom_field_defs WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND entity_type = 'client'`,
      [fieldDefIds, req.workspace.id],
    );
    const defs = new Map(defResult.rows.map((r) => [r.id, r]));
    // Values for a field deleted since the client loaded its definitions are dropped instead of
    // failing the whole save (the other fields' edits still land).
    const knownEntries = parsedEntries.filter((e) => defs.has(e.field_def_id));
    if (knownEntries.length === 0) { res.json([]); return; }
    const normalized = normalizeValues(knownEntries, defs);
    if (typeof normalized === 'string') { res.status(400).json({ error: normalized }); return; }

    const columnsPerRow = 6;
    const valueRows = normalized.map((e) => [
      e.field_def_id, req.params.clientId, req.workspace.id,
      e.value_text, e.value_number, e.value_date,
    ]);
    const placeholders = valueRows
      .map((_, r) => `(${Array.from({ length: columnsPerRow }, (_, c) => `$${r * columnsPerRow + c + 1}`).join(',')})`)
      .join(', ');

    const { rows } = await pool.query(
      `INSERT INTO custom_field_values (field_def_id, client_id, workspace_id, value_text, value_number, value_date)
       VALUES ${placeholders}
       ON CONFLICT (field_def_id, client_id) WHERE client_id IS NOT NULL DO UPDATE
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
