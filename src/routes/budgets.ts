import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { assertLinkableToWorkspace } from '../services/taskService.js';
import { getRequestTz, todayInTz } from '../lib/tz.js';

const router = Router();
router.use(requireWorkspace);

// ─── Schemas ──────────────────────────────────────────────────────────────────

// A budget's time_cost rollup (GET /) sums billable time from tasks matching EITHER the linked
// epic OR the linked sprint — if both were set it would union the two initiatives' tasks rather
// than intersect them, silently changing what the number represents. Enforcing at most one link
// here (matching what the create/edit UI already does) keeps that rollup unambiguous.
// budgets.target_amount is NUMERIC(14,2): at most 12 integer digits.
const TARGET_AMOUNT_MAX = 999_999_999_999.99;

const KNOWN_CURRENCIES: Set<string> | null = (() => {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? new Set(intl.supportedValuesOf('currency')) : null;
  } catch {
    return null;
  }
})();

function isKnownCurrency(code: string): boolean {
  return KNOWN_CURRENCIES === null || KNOWN_CURRENCIES.has(code);
}

const budgetSchemaBase = z.object({
  name:          z.string().trim().min(1).max(255),
  description:   z.preprocess((v) => (v === '' ? null : v), z.string().max(2000).nullable().optional()),
  target_amount: z.number().min(0).max(TARGET_AMOUNT_MAX),
  // ISO 4217 code, normalized to upper case. Checked against the runtime's currency list when
  // available. Note: time_cost (billable time rollup) carries no currency of its own — it is
  // reported as-is and assumed to be in the budget's currency.
  currency:      z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
    .refine(isKnownCurrency, { message: 'Unknown currency code' }).default('USD'),
  period_start:  z.string().date().nullable().optional(),
  period_end:    z.string().date().nullable().optional(),
  status:        z.enum(['active', 'closed']).optional(),
  epic_id:       z.string().uuid().nullable().optional(),
  sprint_id:     z.string().uuid().nullable().optional(),
});
const budgetSchema = budgetSchemaBase
  .refine(
    (d) => !(d.epic_id && d.sprint_id),
    { message: 'A budget can link to an epic or a sprint, not both', path: ['epic_id'] },
  )
  .refine(
    (d) => !(d.period_start && d.period_end && d.period_start > d.period_end),
    { message: 'period_start must be on or before period_end', path: ['period_end'] },
  );

const entrySchema = z.object({
  description: z.string().min(1).max(500),
  amount:      z.number().min(0).max(1_000_000_000),  // L2: cap to prevent display overflows
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
    //
    // budget_entries is pre-aggregated into its own subquery (one row per budget_id) rather
    // than LEFT JOINed directly — joining it straight to `b` before the LATERAL meant the
    // LATERAL's correlated time_logs/tasks subquery re-ran once per budget_entries row for that
    // budget (an N+1-within-a-single-statement pattern) before GROUP BY collapsed the
    // duplicates. Pre-aggregating first means each of the two joins contributes at most one row
    // per budget, so the LATERAL evaluates exactly once per budget and no GROUP BY is needed.
    const result = await pool.query(
      `SELECT b.*,
              COALESCE(be_agg.actual_amount, 0)::numeric AS actual_amount,
              COALESCE(be_agg.entry_count, 0)::int       AS entry_count,
              COALESCE(tc.time_cost, 0)::numeric         AS time_cost
       FROM   budgets b
       LEFT JOIN (
         SELECT budget_id, SUM(amount) AS actual_amount, COUNT(*) AS entry_count
         FROM budget_entries
         WHERE workspace_id = $1
         GROUP BY budget_id
       ) be_agg ON be_agg.budget_id = b.id
       LEFT JOIN LATERAL (
         SELECT SUM((tl.minutes / 60.0) * tl.hourly_rate) AS time_cost
         FROM time_logs tl
         JOIN tasks t ON t.id = tl.task_id
         WHERE t.workspace_id = b.workspace_id
           AND t.deleted_at IS NULL
           AND tl.billable = true
           AND tl.hourly_rate IS NOT NULL
           AND ((b.epic_id IS NOT NULL AND t.epic_id = b.epic_id)
             OR (b.sprint_id IS NOT NULL AND t.sprint_id = b.sprint_id))
       ) tc ON (b.epic_id IS NOT NULL OR b.sprint_id IS NOT NULL)
       WHERE  b.workspace_id = $1
       ORDER  BY b.created_at DESC
       LIMIT  500`,
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
    await assertLinkableToWorkspace('epics', epic_id, req.workspace.id);
    await assertLinkableToWorkspace('sprints', sprint_id, req.workspace.id);
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
    if (Object.values(parsed.data).every((v) => v === undefined)) { res.status(400).json({ error: 'No fields to update' }); return; }

    // Cross-field rules (one link at most, period_start <= period_end) must hold for the
    // resulting row, so a partial PATCH is checked against the stored values.
    const current = await pool.query<{ epic_id: string | null; sprint_id: string | null; period_start: string | null; period_end: string | null }>(
      `SELECT epic_id, sprint_id,
              to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end,   'YYYY-MM-DD') AS period_end
       FROM budgets WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspace.id],
    );
    if (current.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
    const cur = current.rows[0];
    const effectiveEpicId   = parsed.data.epic_id   !== undefined ? parsed.data.epic_id   : cur.epic_id;
    const effectiveSprintId = parsed.data.sprint_id !== undefined ? parsed.data.sprint_id : cur.sprint_id;
    if (effectiveEpicId && effectiveSprintId) {
      res.status(400).json({ error: 'A budget can link to an epic or a sprint, not both' });
      return;
    }
    const effectiveStart = parsed.data.period_start !== undefined ? parsed.data.period_start : cur.period_start;
    const effectiveEnd   = parsed.data.period_end   !== undefined ? parsed.data.period_end   : cur.period_end;
    if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
      res.status(400).json({ error: 'period_start must be on or before period_end' });
      return;
    }
    if (parsed.data.epic_id !== undefined) await assertLinkableToWorkspace('epics', parsed.data.epic_id, req.workspace.id);
    if (parsed.data.sprint_id !== undefined) await assertLinkableToWorkspace('sprints', parsed.data.sprint_id, req.workspace.id);

    // H2: explicit allowlist prevents future mass-assignment if schema expands
    // undefined = unchanged; null = clear (description, period dates, epic/sprint links).
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
       ORDER  BY be.entry_date DESC, be.created_at DESC
       LIMIT  1000`,
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
      [req.params.id, req.workspace.id, description, amount, category ?? null, entry_date ?? todayInTz(getRequestTz(req)), req.auth.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/budgets/:id/entries/:entryId
router.delete('/:id/entries/:entryId', async (req, res, next) => {
  try {
    // Same rule as adding entries: a closed budget's ledger is frozen (reopen it to edit).
    const check = await pool.query<{ status: string }>(
      'SELECT status FROM budgets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Budget not found' }); return; }
    if (check.rows[0].status === 'closed') {
      res.status(400).json({ error: 'Cannot delete entries from a closed budget' });
      return;
    }
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
