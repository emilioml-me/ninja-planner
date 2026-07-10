// POST /api/tasks/import — bulk task import from CSV text
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const rowSchema = z.object({
  title:             z.string().min(1).max(500),
  description:       z.string().max(10000).optional(),
  status:            z.enum(['todo', 'in_progress', 'done', 'blocked']).default('todo'),
  priority:          z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  due_date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  tags:              z.string().max(2000).optional(),
  assignee_clerk_id: z.string().nullable().optional(),
});

const MAX_TAGS_PER_ROW = 50;

// RFC-4180-ish tokenizer: handles quoted fields containing commas/newlines and "" escaped quotes.
// A naive split(',')/split(/\r?\n/) (the previous implementation) silently shifts every field
// after an embedded comma/newline into the wrong column instead of erroring.
function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += char; i++; continue;
    }
    if (char === '"') { inQuotes = true; i++; continue; }
    if (char === ',') { row.push(field); field = ''; i++; continue; }
    if (char === '\r') { i++; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += char; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Parses a CSV string (first row = headers) into an array of objects
function parseCsv(text: string): Record<string, string>[] {
  const rows = tokenizeCsv(text).filter((r) => r.some((v) => v.trim() !== ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((vals) =>
    Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()])),
  );
}

// POST /api/tasks/import
// Body: { csv: string }  OR  { rows: object[] }
router.post('/', async (req, res, next) => {
  try {
    let rawRows: Record<string, string>[];
    if (typeof req.body.csv === 'string') {
      rawRows = parseCsv(req.body.csv);
    } else if (Array.isArray(req.body.rows)) {
      rawRows = req.body.rows;
    } else {
      res.status(400).json({ error: 'Provide csv string or rows array' });
      return;
    }

    if (rawRows.length === 0)  { res.status(400).json({ error: 'No rows found' }); return; }
    if (rawRows.length > 500)  { res.status(400).json({ error: 'Max 500 rows per import' }); return; }

    const errors: { row: number; error: string }[] = [];
    const toInsert: z.infer<typeof rowSchema>[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const parsed = rowSchema.safeParse(rawRows[i]);
      if (!parsed.success) {
        errors.push({ row: i + 2, error: JSON.stringify(parsed.error.flatten().fieldErrors) });
      } else {
        toInsert.push(parsed.data);
      }
    }

    if (errors.length > 0 && toInsert.length === 0) {
      res.status(422).json({ error: 'All rows failed validation', details: errors }); return;
    }

    // Validate assignees are members of this workspace (prevents bulk-assigning to
    // arbitrary external Clerk IDs, mirroring the check in tasks.ts POST/PATCH).
    const assigneeIds = [...new Set(toInsert.map((r) => r.assignee_clerk_id).filter((id): id is string => !!id))];
    let validAssignees = new Set<string>();
    if (assigneeIds.length > 0) {
      const memberResult = await pool.query<{ clerk_user_id: string }>(
        'SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = ANY($2::text[])',
        [req.workspace.id, assigneeIds],
      );
      validAssignees = new Set(memberResult.rows.map((r) => r.clerk_user_id));
    }

    // Build one multi-row INSERT instead of one round-trip per row — up to 500 sequential
    // awaited inserts inside a single transaction was holding one of the pool's 10 connections
    // for the whole import, risking pool exhaustion for other tenants during a large import.
    const valueRows: unknown[][] = [];
    for (let i = 0; i < toInsert.length; i++) {
      const row = toInsert[i];
      const tags = row.tags
        ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean).slice(0, MAX_TAGS_PER_ROW)
        : [];
      const assigneeId = row.assignee_clerk_id && validAssignees.has(row.assignee_clerk_id)
        ? row.assignee_clerk_id
        : null;
      if (row.assignee_clerk_id && !assigneeId) {
        errors.push({ row: i + 2, error: 'assignee_clerk_id is not a member of this workspace — imported unassigned' });
      }
      valueRows.push([
        req.workspace.id, row.title, row.description ?? null, row.status, row.priority,
        row.due_date ?? null, tags, req.auth.userId, assigneeId,
      ]);
    }

    const COLUMNS_PER_ROW = 9;
    const placeholders = valueRows
      .map((_, r) => `(${Array.from({ length: COLUMNS_PER_ROW }, (_, c) => `$${r * COLUMNS_PER_ROW + c + 1}`).join(',')})`)
      .join(', ');

    const client = await pool.connect();
    let imported: { id: string; title: string }[] = [];
    try {
      await client.query('BEGIN');
      if (valueRows.length > 0) {
        const result = await client.query<{ id: string; title: string }>(
          `INSERT INTO tasks
             (workspace_id, title, description, status, priority, due_date, tags, created_by, assignee_clerk_id)
           VALUES ${placeholders}
           RETURNING id, title`,
          valueRows.flat(),
        );
        imported = result.rows;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      imported: imported.length,
      skipped: errors.length,
      tasks: imported,
      ...(errors.length > 0 ? { validation_errors: errors } : {}),
    });
  } catch (err) { next(err); }
});

export default router;
