import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import {
  getTimeLogs, addTimeLog, deleteTimeLog, setTimeLogBudgetEntry,
} from '../services/timeLogService.js';

// mergeParams: true — :taskId comes from the parent tasks router
const router = Router({ mergeParams: true });
router.use(requireWorkspace);

const createSchema = z.object({
  minutes:     z.number().int().min(1).max(14400),
  note:        z.string().max(500).optional(),
  billable:    z.boolean().optional(),
  hourly_rate: z.number().min(0).max(10000).nullable().optional(),
});

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
    res.json(logs);
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

// PATCH /api/tasks/:taskId/time-logs/:id/budget-entry — link/unlink a log to a budget entry
router.patch('/:id/budget-entry', async (req, res, next) => {
  try {
    const schema = z.object({ budget_entry_id: z.string().uuid().nullable() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');
    const log = await setTimeLogBudgetEntry(req.params.id, req.workspace.id, req.auth.userId, isAdmin, parsed.data.budget_entry_id);
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
      req.workspace.id,
      req.auth.userId,
      isAdmin,
    );
    if (!deleted) { res.status(404).json({ error: 'Log not found or not yours' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
