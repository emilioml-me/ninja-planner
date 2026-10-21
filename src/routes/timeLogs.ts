import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import {
  getTimeLogs, addTimeLog, deleteTimeLog, setTimeLogBudgetEntry, updateTimeLog,
} from '../services/timeLogService.js';

// mergeParams: true — :taskId comes from the parent tasks router
const router = Router({ mergeParams: true });
router.use(requireWorkspace);

const createSchema = z.object({
  minutes:     z.number().int().min(1).max(14400),
  note:        z.string().max(500).optional(),
  // Only admins may set a rate (it drives budget time_cost rollups); see POST below.
  billable:    z.boolean().optional(),
  hourly_rate: z.number().min(0).max(10000).nullable().optional(),
});

const updateSchema = z.object({
  minutes:     z.number().int().min(1).max(14400).optional(),
  note:        z.string().max(500).nullable().optional(),
  billable:    z.boolean().optional(),
  // Admin-only (see PATCH below) - lets an admin price member-logged billable time.
  hourly_rate: z.number().min(0).max(10000).nullable().optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), { message: 'Nothing to update' });

// GET /api/tasks/:taskId/time-logs
router.get('/', async (req, res, next) => {
  try {
    // Verify task belongs to workspace
    const check = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    const logs = await getTimeLogs((req.params as Record<string, string>).taskId, req.workspace.id);
    // Rates are admin data: non-admins only see the rate on their own logs.
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    res.json(isAdmin ? logs : logs.map((l) => (
      l.user_clerk_id === req.auth.userId ? l : { ...l, hourly_rate: null }
    )));
  } catch (err) { next(err); }
});

// POST /api/tasks/:taskId/time-logs
router.post('/', async (req, res, next) => {
  try {
    const check = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    // hourly_rate feeds every budget's time_cost rollup, so a member must not be able to price
    // their own time; members log billable time without a rate (an admin can price it later).
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    if (!isAdmin && parsed.data.hourly_rate != null) {
      res.status(403).json({ error: 'Only workspace admins can set an hourly rate' });
      return;
    }

    const log = await addTimeLog(
      (req.params as Record<string, string>).taskId,
      req.workspace.id,
      req.auth.userId,
      parsed.data.minutes,
      parsed.data.note,
      parsed.data.billable,
      parsed.data.hourly_rate,
    );
    res.status(201).json(log);
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:taskId/time-logs/:id — edit a log (own log, or any log for admins).
// hourly_rate is admin-only: it is how an admin prices billable time a member logged.
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    if (!isAdmin && parsed.data.hourly_rate !== undefined) {
      res.status(403).json({ error: 'Only workspace admins can set an hourly rate' });
      return;
    }

    const log = await updateTimeLog(
      req.params.id,
      (req.params as Record<string, string>).taskId,
      req.workspace.id,
      req.auth.userId,
      isAdmin,
      parsed.data,
    );
    if (!log) { res.status(404).json({ error: 'Log not found or not yours' }); return; }
    res.json(log);
  } catch (err) { next(err); }
});

// PATCH /api/tasks/:taskId/time-logs/:id/budget-entry — link/unlink a log to a budget entry
router.patch('/:id/budget-entry', async (req, res, next) => {
  try {
    const schema = z.object({ budget_entry_id: z.string().uuid().nullable() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    const log = await setTimeLogBudgetEntry(
      req.params.id, (req.params as Record<string, string>).taskId, req.workspace.id, req.auth.userId, isAdmin, parsed.data.budget_entry_id,
    );
    if (!log) { res.status(404).json({ error: 'Log not found, not yours, or budget entry not found' }); return; }
    res.json(log);
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:taskId/time-logs/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    const deleted = await deleteTimeLog(
      req.params.id,
      (req.params as Record<string, string>).taskId,
      req.workspace.id,
      req.auth.userId,
      isAdmin,
    );
    if (!deleted) { res.status(404).json({ error: 'Log not found or not yours' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
