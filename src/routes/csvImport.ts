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
  tags:              z.string().optional(),
  assignee_clerk_id: z.string().nullable().optional(),
});

// Parses a CSV string (first row = headers) into an array of objects
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const vals = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
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

    const client = await pool.connect();
    const imported: { id: string; title: string }[] = [];
    try {
      await client.query('BEGIN');
      for (const row of toInsert) {
        const tags = row.tags ? row.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [];
        const result = await client.query(
          `INSERT INTO tasks
             (workspace_id, title, description, status, priority, due_date, tags, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id, title`,
          [req.workspace.id, row.title, row.description ?? null, row.status, row.priority,
           row.due_date ?? null, tags, req.auth.userId],
        );
        imported.push(result.rows[0]);
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
