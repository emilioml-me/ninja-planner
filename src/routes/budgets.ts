import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

// ─── Schemas ──────────────────────────────────────────────────────────────────

// A budget's time_cost rollup (GET /) sums billable time from tasks matching EITHER the linked
// epic OR the linked sprint — if both were set it would union the two initiatives' tasks rather
// than intersect them, silently changing what the number represents. Enforcing at most one link
// here (matching what the create/edit UI already does) keeps that rollup unambiguous.
const budgetSchemaBase = z.object({
  name:          z.string().min(1).max(255),
  description:   z.string().max(2000).optional(),
  target_amount: z.number().min(0),
  currency:      z.string().length(3).default('USD'),
  period_start:  z.string().date().nullable().optional(),
  period_end:    z.string().date().nullable().optional(),
  status:        z.enum(['active', 'closed']).optional(),
  epic_id:       z.string().uuid().nullable().optional(),
  sprint_id:     z.string().uuid().nullable().optional(),
});
const budgetSchema = budgetSchemaBase.refine(
  (d) => !(d.epic_id && d.sprint_id),
  { message: 'A budget can link to an epic or a sprint, not both', path: ['epic_id'] },
);

const entrySchema = z.object({
  description: z.string().min(1).max(500),
  amount:      z.number().max(1_000_000_000),  // L2: cap to prevent display overflows
  category:    z.string().max(100).optional(),
  entry_date:  z.string().date().nullable().optional(),
});

// ─── Budget CRUD ──────────────────────────────────────────────────────────────

// GET /api/budgets
router.get('/', async (req, res, next) => {
  try {
    // time_cost is a separate rollup from actual_amount (manual budget_entries): for a budget
    // linked to an epic or sprint, it sums billable time already logged against that
    // initiative's tasks (minutes/60 * hourly_rate), giving a spend estimate that doesn't
    // require someone to also manually re-enter it as a budget entry.
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(SUM(be.amount), 0)::numeric AS actual_amount,
              COUNT(be.id)::int                    AS entry_count,
              COALESCE(tc.time_cost, 0)::numeric   AS time_cost
       FROM   budgets b
       LEFT JOIN budget_entries be ON be.budget_id = b.id
       LEFT JOIN LATERAL (
         SELECT SUM((tl.minutes / 60.0) * tl.hourly_rate) AS time_cost
         FROM time_logs tl
         JOIN tasks t ON t.id = tl.task_id
         WHERE t.workspace_id = b.workspace_id
           AND tl.billable = true
           AND tl.hourly_rate IS NOT NULL
           AND ((b.epic_id IS NOT NULL AND t.epic_id = b.epic_id)
             OR (b.sprint_id IS NOT NULL AND t.sprint_id = b.sprint_id))
       ) tc ON (b.epic_id IS NOT NULL OR b.sprint_id IS NOT NULL)
       WHERE  b.workspace_id = $1
       GROUP  BY b.id, tc.time_cost
       ORDER  BY b.created_at DESC`,
      [req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/budgets  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, description, target_amount, currency, period_start, period_end, status, epic_id, sprint_id } = parsed.data;
    const result = await pool.query(
      `INSERT INTO budgets (workspace_id, name, description, target_amount, currency, period_start, period_end, status, created_by, epic_id, sprint_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.workspace.id, name, description ?? null, target_amount, currency, period_start ?? null, period_end ?? null, status ?? 'active', req.auth.userId, epic_id ?? null, sprint_id ?? null],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/budgets/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = budgetSchemaBase.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    if (parsed.data.epic_id !== undefined || parsed.data.sprint_id !== undefined) {
      const current = await pool.query<{ epic_id: string | null; sprint_id: string | null }>(
        'SELECT epic_id, sprint_id FROM budgets WHERE id = $1 AND workspace_id = $2',
        [req.params.id, req.workspace.id],
      );
      if (current.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
      const effectiveEpicId   = parsed.data.epic_id   !== undefined ? parsed.data.epic_id   : current.rows[0].epic_id;
      const effectiveSprintId = parsed.data.sprint_id !== undefined ? parsed.data.sprint_id : current.rows[0].sprint_id;
      if (effectiveEpicId && effectiveSprintId) {
        res.status(400).json({ error: 'A budget can link to an epic or a sprint, not both' });
        return;
      }
    }

    // H2: explicit allowlist prevents future mass-assignment if schema expands
    const ALLOWED_COLUMNS = new Set<string>(['name','description','target_amount','currency','period_start','period_end','status','epic_id','sprint_id']);
    const fields = parsed.data;
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      if (val !== undefined && ALLOWED_COLUMNS.has(key)) {
        setClauses.push(`${key} = $${i++}`);
        values.push(val);
      }
    }
    setClauses.push(`updated_at = now()`);
    values.push(req.params.id, req.workspace.id);

    const result = await pool.query(
      `UPDATE budgets SET ${setClauses.join(', ')}
       WHERE id = $${i++} AND workspace_id = $${i}
       RETURNING *`,
      values,
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/budgets/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM budgets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Budget entries ───────────────────────────────────────────────────────────

// GET /api/budgets/entries  — flat list of entries across all open budgets, for the
// "link this time log to a budget entry" picker (avoids fetching every budget's entries client-side)
router.get('/entries', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT be.id, be.description, be.amount, be.entry_date, b.id AS budget_id, b.name AS budget_name
       FROM budget_entries be
       JOIN budgets b ON b.id = be.budget_id
       WHERE be.workspace_id = $1 AND b.status = 'active'
       ORDER BY be.entry_date DESC, be.created_at DESC
       LIMIT 200`,
      [req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// GET /api/budgets/:id/entries
router.get('/:id/entries', async (req, res, next) => {
  try {
    const check = await pool.query(
      'SELECT id FROM budgets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }

    const result = await pool.query(
      `SELECT be.*, wm.display_name
       FROM   budget_entries be
       LEFT JOIN workspace_members wm
              ON wm.clerk_user_id = be.created_by
             AND wm.workspace_id  = be.workspace_id
       WHERE  be.budget_id = $1 AND be.workspace_id = $2   -- M3: defence-in-depth workspace scope
       ORDER  BY be.entry_date DESC, be.created_at DESC`,
      [req.params.id, req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/budgets/:id/entries
router.post('/:id/entries', async (req, res, next) => {
  try {
    const check = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM budgets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
    // status='closed' was previously a label only — nothing stopped new entries from being
    // added to a budget the team had already closed out.
    if (check.rows[0].status === 'closed') {
      res.status(400).json({ error: 'Cannot add entries to a closed budget' });
      return;
    }

    const parsed = entrySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { description, amount, category, entry_date } = parsed.data;
    // The UI now always sends entry_date computed in the user's local timezone (see
    // client/src/lib/utils.ts todayLocal()) rather than relying on this fallback, which the
    // server has no way to make timezone-correct — it can only default to server-UTC "today"
    // for callers (e.g. a direct API integration) that omit the field entirely.
    const result = await pool.query(
      `INSERT INTO budget_entries (budget_id, workspace_id, description, amount, category, entry_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.id, req.workspace.id, description, amount, category ?? null, entry_date ?? new Date().toISOString().slice(0, 10), req.auth.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/budgets/:id/entries/:entryId
router.delete('/:id/entries/:entryId', async (req, res, next) => {
  try {
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    const query = isAdmin
      ? 'DELETE FROM budget_entries WHERE id = $1 AND budget_id = $2 AND workspace_id = $3'
      : 'DELETE FROM budget_entries WHERE id = $1 AND budget_id = $2 AND workspace_id = $3 AND created_by = $4';
    const params = isAdmin
      ? [req.params.entryId, req.params.id, req.workspace.id]
      : [req.params.entryId, req.params.id, req.workspace.id, req.auth.userId];
    const result = await pool.query(query, params);
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Entry not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
