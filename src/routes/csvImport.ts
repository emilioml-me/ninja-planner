// POST /api/tasks/import — bulk task import from CSV text
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';
import { isTaskDateInBounds, TASK_DATE_RANGE_MESSAGE, type Task } from '../services/taskService.js';
import { getEndpoints, deliverToEndpoint } from '../services/webhookService.js';
import { dispatchAutomations } from '../services/automationService.js';
import { trackBackground } from '../lib/background.js';
import { logger } from '../config/logger.js';

const router = Router();
router.use(requireWorkspace);

const rowSchema = z.object({
  title:             z.string().min(1).max(500),
  description:       z.string().max(10000).optional(),
  status:            z.enum(['todo', 'in_progress', 'done', 'blocked']).default('todo'),
  priority:          z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  // .date() rejects impossible dates (2024-02-30) per row instead of letting one bad cell roll
  // back the whole multi-row INSERT with a generic error.
  due_date:          z.string().date().refine(isTaskDateInBounds, { message: TASK_DATE_RANGE_MESSAGE }).nullable().optional(),
  tags:              z.string().max(2000).optional(),
  assignee_clerk_id: z.string().max(255).nullable().optional(),
});

const MAX_TAGS_PER_ROW = 50;
const MAX_TAG_LENGTH = 200;
// Bounded fan-out for post-import webhooks/automations (up to 500 tasks per import).
const POST_IMPORT_CONCURRENCY = 5;

// RFC-4180-ish tokenizer: handles quoted fields containing commas/newlines and "" escaped quotes.
// A naive split(',')/split(/\r?\n/) (the previous implementation) silently shifts every field
// after an embedded comma/newline into the wrong column instead of erroring.
// Each record carries the file line number it starts on, so validation errors point at the right
// line even after blank lines or multi-line quoted fields.
interface CsvRecord { line: number; values: string[] }

class CsvParseError extends Error {}

function tokenizeCsv(text: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let quoteStartLine = 1;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      if (char === '\n') line++;
      field += char; i++; continue;
    }
    if (char === '"') { inQuotes = true; quoteStartLine = line; i++; continue; }
    if (char === ',') { row.push(field); field = ''; i++; continue; }
    if (char === '\r') { i++; continue; }
    if (char === '\n') {
      row.push(field); rows.push({ line: rowStartLine, values: row });
      row = []; field = ''; i++; line++; rowStartLine = line;
      continue;
    }
    field += char; i++;
  }
  // An unterminated quote used to silently swallow the rest of the file into one field.
  if (inQuotes) throw new CsvParseError(`Unterminated quoted field starting on line ${quoteStartLine}`);
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push({ line: rowStartLine, values: row }); }
  return rows;
}

// Parses a CSV string (first row = headers) into an array of objects
// Header matching is case/whitespace-insensitive ("Title", " Due Date " -> title, due_date) —
// spreadsheet exports rarely keep lowercase snake_case headers, and previously any other casing
// silently dropped the column (a "Title" header failed every row as missing title).
function normalizeHeader(h: string): string {
  return h.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeRowKeys(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[normalizeHeader(k)] = v === null || v === undefined ? '' : String(v).trim();
  }
  return out;
}

function parseCsv(text: string): { rows: Record<string, string>[]; lines: number[] } {
  // Strip a UTF-8 BOM (Excel and our own CSV export prepend one) so it doesn't end up glued to
  // the first header name.
  const records = tokenizeCsv(text.replace(/^\uFEFF/, '')).filter((r) => r.values.some((v) => v.trim() !== ''));
  if (records.length < 2) return { rows: [], lines: [] };
  const headers = records[0].values.map(normalizeHeader);
  const data = records.slice(1);
  return {
    rows: data.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r.values[i] ?? '').trim()]))),
    lines: data.map((r) => r.line),
  };
}

// task.created webhooks + automations for an import, with bounded concurrency. Previously each
// imported task called fireWebhooks separately: up to 500 concurrent endpoint lookups and
// 500 x N outbound POSTs at once, and automations never ran for imported tasks. The subscribed
// endpoints are looked up once; an endpoint that keeps failing is dropped for the rest of the
// import instead of retrying (10s/60s backoff) for every remaining task.
const MAX_CONSECUTIVE_ENDPOINT_FAILURES = 3;

async function runPostImportEffects(workspaceId: string, tasks: Task[]): Promise<void> {
  const endpoints = (await getEndpoints(workspaceId))
    .filter((e) => e.active && e.events.includes('task.created'))
    .map((e) => e.id);
  const failures = new Map<string, number>();

  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      for (const endpointId of endpoints) {
        if ((failures.get(endpointId) ?? 0) >= MAX_CONSECUTIVE_ENDPOINT_FAILURES) continue;
        const outcome = await deliverToEndpoint(endpointId, workspaceId, 'task.created', { task })
          .catch(() => 'failed' as const);
        failures.set(endpointId, outcome === 'failed' ? (failures.get(endpointId) ?? 0) + 1 : 0);
      }
      await dispatchAutomations({
        type: 'task.created',
        workspaceId,
        taskId: task.id,
        assigneeId: task.assignee_clerk_id,
        title: task.title,
      }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(POST_IMPORT_CONCURRENCY, tasks.length) }, worker));

  const dropped = [...failures].filter(([, n]) => n >= MAX_CONSECUTIVE_ENDPOINT_FAILURES).map(([id]) => id);
  if (dropped.length > 0) {
    logger.warn({ workspaceId, endpointIds: dropped }, '[csvImport] webhook endpoints skipped after repeated failures');
  }
}

// POST /api/tasks/import
// Body: { csv: string }  OR  { rows: object[] }
router.post('/', async (req, res, next) => {
  try {
    let rawRows: Record<string, string>[];
    // Reported row number per raw row: the file line for CSV text, index + 2 (as if a header
    // row came first) for a rows array.
    let rowNumbers: number[];
    if (typeof req.body.csv === 'string') {
      try {
        ({ rows: rawRows, lines: rowNumbers } = parseCsv(req.body.csv));
      } catch (err) {
        if (err instanceof CsvParseError) { res.status(400).json({ error: err.message }); return; }
        throw err;
      }
    } else if (Array.isArray(req.body.rows)) {
      if (req.body.rows.some((r: unknown) => !r || typeof r !== 'object' || Array.isArray(r))) {
        res.status(400).json({ error: 'rows must be an array of objects' });
        return;
      }
      rawRows = (req.body.rows as Record<string, unknown>[]).map(normalizeRowKeys);
      rowNumbers = rawRows.map((_, i) => i + 2);
    } else {
      res.status(400).json({ error: 'Provide csv string or rows array' });
      return;
    }

    if (rawRows.length === 0)  { res.status(400).json({ error: 'No rows found' }); return; }
    if (rawRows.length > 500)  { res.status(400).json({ error: 'Max 500 rows per import' }); return; }

    const errors: { row: number; error: string }[] = [];
    // Distinct from `errors`: rows that DO get imported but with a caveat (e.g. an assignee
    // that isn't a workspace member gets silently cleared to null). Previously these were
    // pushed into the same `errors` array and counted toward the response's `skipped` total,
    // even though the row was actually inserted — so `imported + skipped` could exceed the
    // input row count, and "skipped" didn't mean what it implied to a caller building an
    // import-summary UI from this response.
    const warnings: { row: number; warning: string }[] = [];
    const toInsert: z.infer<typeof rowSchema>[] = [];
    const sourceRowNumbers: number[] = []; // file row number (header = 1) for each toInsert entry

    // parseCsv always produces '' (never undefined) for a column present in the header but
    // blank on a given row — very common in real-world exports (spreadsheet templates keep
    // every column even when only some are filled in). z.enum().default() and .regex() only
    // fall back / apply their intended semantics on `undefined`, not on an empty-but-present
    // string, so a blank due_date/status/priority cell was previously rejected outright instead
    // of using the schema's default/null. Blank cells for optional fields are normalized to
    // undefined before validation so they get the intended default/omitted behavior; `title`
    // (required) is deliberately excluded so a blank required field still fails validation.
    const OPTIONAL_FIELDS = ['description', 'status', 'priority', 'due_date', 'tags', 'assignee_clerk_id'] as const;
    function normalizeBlankCells(row: Record<string, string>): Record<string, string | undefined> {
      const out: Record<string, string | undefined> = { ...row };
      for (const key of OPTIONAL_FIELDS) {
        if (out[key] === '') out[key] = undefined;
      }
      return out;
    }

    for (let i = 0; i < rawRows.length; i++) {
      const parsed = rowSchema.safeParse(normalizeBlankCells(rawRows[i]));
      if (!parsed.success) {
        errors.push({ row: rowNumbers[i], error: JSON.stringify(parsed.error.flatten().fieldErrors) });
      } else {
        toInsert.push(parsed.data);
        sourceRowNumbers.push(rowNumbers[i]);
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
        ? row.tags.split(/[;|]/).map((t) => t.trim().slice(0, MAX_TAG_LENGTH)).filter(Boolean).slice(0, MAX_TAGS_PER_ROW)
        : [];
      const assigneeId = row.assignee_clerk_id && validAssignees.has(row.assignee_clerk_id)
        ? row.assignee_clerk_id
        : null;
      if (row.assignee_clerk_id && !assigneeId) {
        warnings.push({ row: sourceRowNumbers[i], warning: 'assignee_clerk_id is not a member of this workspace — imported unassigned' });
      }
      valueRows.push([
        req.workspace.id, row.title, row.description ?? null, row.status, row.priority,
        row.due_date ?? null, tags, req.auth.userId, assigneeId,
      ]);
    }

    const COLUMNS_PER_ROW = 10;
    const placeholders = valueRows
      .map((_, r) => `(${Array.from({ length: COLUMNS_PER_ROW }, (_, c) => `$${r * COLUMNS_PER_ROW + c + 1}`).join(',')})`)
      .join(', ');

    const client = await pool.connect();
    let imported: Task[] = [];
    try {
      await client.query('BEGIN');
      if (valueRows.length > 0) {
        // Imported tasks are appended after the workspace's current highest position, in file
        // order — previously every row got position 0, so the imported order was lost and the
        // tasks interleaved arbitrarily with existing position-0 cards on the board.
        const posResult = await client.query<{ next_pos: number }>(
          'SELECT COALESCE(MAX(position), -1)::int + 1 AS next_pos FROM tasks WHERE workspace_id = $1 AND deleted_at IS NULL',
          [req.workspace.id],
        );
        const basePosition = posResult.rows[0]?.next_pos ?? 0;
        valueRows.forEach((row, idx) => row.push(basePosition + idx));

        const result = await client.query<Task>(
          `INSERT INTO tasks
             (workspace_id, title, description, status, priority, due_date, tags, created_by, assignee_clerk_id, position)
           VALUES ${placeholders}
           RETURNING *`,
          valueRows.flat(),
        );
        imported = result.rows;

        // One 'created' activity row per task (with status, like POST /api/tasks) so imports
        // show up in the changelog/burndown/activity feed.
        await client.query(
          `INSERT INTO task_activity (task_id, actor_clerk_id, action, payload)
           SELECT t.id, $2, 'created', jsonb_build_object('status', t.status, 'source', 'csv')
           FROM tasks t WHERE t.id = ANY($1::uuid[])`,
          [imported.map((t) => t.id), req.auth.userId],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (imported.length > 0) {
      const workspaceId = req.workspace.id;
      void trackBackground(runPostImportEffects(workspaceId, imported)).catch((err) => {
        logger.warn({ err, workspaceId }, '[csvImport] post-import webhooks/automations failed');
      });
    }

    res.status(201).json({
      imported: imported.length,
      skipped: errors.length,
      tasks: imported.map((t) => ({ id: t.id, title: t.title })),
      ...(errors.length > 0 ? { validation_errors: errors } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  } catch (err) { next(err); }
});

export default router;
