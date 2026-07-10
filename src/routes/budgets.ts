import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const budgetSchema = z.object({
  name:          z.string().min(1).max(255),
  description:   z.string().max(2000).optional(),
  target_amount: z.number().min(0),
  currency:      z.string().length(3).default('USD'),
  period_start:  z.string().date().nullable().optional(),
  period_end:    z.string().date().nullable().optional(),
  status:        z.enum(['active', 'closed']).optional(),
});

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
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(SUM(be.amount), 0)::numeric AS actual_amount,
              COUNT(be.id)::int                    AS entry_count
       FROM   budgets b
       LEFT JOIN budget_entries be ON be.budget_id = b.id
       WHERE  b.workspace_id = $1
       GROUP  BY b.id
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
    const { name, description, target_amount, currency, period_start, period_end, status } = parsed.data;
    const result = await pool.query(
      `INSERT INTO budgets (workspace_id, name, description, target_amount, currency, period_start, period_end, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.workspace.id, name, description ?? null, target_amount, currency, period_start ?? null, period_end ?? null, status ?? 'active', req.auth.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/budgets/:id  [admin only]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = budgetSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }

    // H2: explicit allowlist prevents future mass-assignment if schema expands
    const ALLOWED_COLUMNS = new Set<string>(['name','description','target_amount','currency','period_start','period_end','status']);
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
    const check = await pool.query(
      'SELECT id FROM budgets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }

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
