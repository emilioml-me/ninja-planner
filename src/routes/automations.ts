// Automation rules: trigger/action engine for workspace events
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { dispatchAutomations } from '../services/automationService.js';

const router = Router();
router.use(requireWorkspace);

export const TRIGGER_TYPES = ['task.status_changed', 'task.assigned', 'task.due_date_passed', 'task.created'] as const;
export const ACTION_TYPES  = ['notify_assignee', 'reassign_task', 'set_status', 'post_webhook'] as const;

const ruleSchema = z.object({
  name:           z.string().min(1).max(200),
  trigger_type:   z.enum(TRIGGER_TYPES),
  trigger_config: z.record(z.unknown()).default({}),
  action_type:    z.enum(ACTION_TYPES),
  action_config:  z.record(z.unknown()).default({}),
  active:         z.boolean().default(true),
});

// GET /api/automations
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, trigger_type, trigger_config, action_type, action_config, active, created_at
       FROM automation_rules WHERE workspace_id = $1 ORDER BY created_at`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/automations/:id/logs
router.get('/:id/logs', requireAdmin, async (req, res, next) => {
  try {
    const check = await pool.query(
      'SELECT id FROM automation_rules WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

    const { rows } = await pool.query(
      `SELECT id, result, error_message, trigger_payload, ran_at
       FROM automation_logs WHERE rule_id = $1
       ORDER BY ran_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/automations  [admin]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, trigger_type, trigger_config, action_type, action_config, active } = parsed.data;

    const { rows } = await pool.query(
      `INSERT INTO automation_rules
         (workspace_id, name, trigger_type, trigger_config, action_type, action_config, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.workspace.id, name, trigger_type, trigger_config, action_type, action_config, active, req.auth.userId],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/automations/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = ruleSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const ALLOWED = ['name', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'active'] as const;
    for (const key of ALLOWED) {
      if (key in parsed.data) {
        fields.push(`${key} = $${i++}`);
        values.push((parsed.data as Record<string, unknown>)[key]);
      }
    }
    if (fields.length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }
    fields.push(`updated_at = now()`);
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query(
      `UPDATE automation_rules SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/automations/due-date-check  [admin only]
// Dispatches the task.due_date_passed trigger for tasks that just became overdue.
// Meant to be hit periodically by an external scheduler, mirroring the POST /api/tasks/alert-check
// pattern used for the Slack overdue digest. Was previously a dead trigger type: it could be
// configured on a rule but nothing anywhere ever dispatched it.
router.post('/due-date-check', requireAdmin, async (req, res, next) => {
  try {
    const { rows: overdue } = await pool.query<{
      id: string; title: string; assignee_clerk_id: string | null;
    }>(
      `SELECT id, title, assignee_clerk_id
       FROM tasks
       WHERE workspace_id = $1
         AND status <> 'done'
         AND deleted_at IS NULL
         AND due_date < CURRENT_DATE
         AND due_date_passed_notified_at IS NULL
       LIMIT 200`,
      [req.workspace.id],
    );

    for (const task of overdue) {
      await dispatchAutomations({
        type: 'task.due_date_passed',
        workspaceId: req.workspace.id,
        taskId: task.id,
        assigneeId: task.assignee_clerk_id,
        title: task.title,
      });
      await pool.query(
        `UPDATE tasks SET due_date_passed_notified_at = now() WHERE id = $1 AND workspace_id = $2`,
        [task.id, req.workspace.id],
      );
    }

    res.json({ ok: true, dispatched: overdue.length });
  } catch (err) { next(err); }
});

// DELETE /api/automations/:id  [admin]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      'DELETE FROM automation_rules WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
