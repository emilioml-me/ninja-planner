// Automation rules: trigger/action engine for workspace events
import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { claimOverdueTasks, dispatchDueDatePassed } from '../services/automationService.js';

const router = Router();
router.use(requireWorkspace);

export const TRIGGER_TYPES = [
  'task.status_changed', 'task.assigned', 'task.due_date_passed', 'task.created',
  'sprint.completed', 'epic.completed', 'goal.completed',
] as const;
export const ACTION_TYPES  = ['notify_assignee', 'reassign_task', 'set_status', 'post_webhook'] as const;

// trigger_config/action_config were previously unshaped z.record(unknown()) — a malformed value
// (wrong key name, wrong type) wasn't rejected at creation time, it just silently no-op'd at
// dispatch (automationService.ts's executeAction/triggerMatches guard every field access with
// `if (!x) break`/`if (cfg.x && ...)`). Validating the actual shape each action/trigger type
// expects here means bad config fails fast instead of quietly never firing.
// Must match the task status enum in routes/tasks.ts — a free-form string here let a rule set a
// task to a status the rest of the app can't render, or filter on a status that never occurs.
const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'] as const;
// '' (an "any" select option) is treated as "no filter".
const optionalStatusFilter = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.enum(TASK_STATUSES).optional(),
);

const triggerConfigSchema = z.object({
  from_status:       optionalStatusFilter,
  to_status:         optionalStatusFilter,
  assignee_clerk_id: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().max(255).optional()),
}).strict();

const actionConfigSchemas: Record<typeof ACTION_TYPES[number], z.ZodTypeAny> = {
  set_status:      z.object({ status: z.enum(TASK_STATUSES) }).strict(),
  reassign_task:   z.object({ assignee_clerk_id: z.string().trim().min(1).max(255) }).strict(),
  notify_assignee: z.object({ title: z.string().max(200).optional(), message: z.string().max(1000).optional() }).strict(),
  post_webhook:    z.object({ endpoint_id: z.string().uuid() }).strict(),
};

function validateActionConfig(actionType: string, actionConfig: unknown): string | null {
  const schema = actionConfigSchemas[actionType as typeof ACTION_TYPES[number]];
  if (!schema) return 'Unknown action_type';
  const result = schema.safeParse(actionConfig);
  return result.success ? null : `Invalid action_config for ${actionType}: ${result.error.message}`;
}

// Triggers whose events carry a task (and so an assignee). sprint/epic/goal events don't, so
// task actions on them could only ever no-op.
const TASK_TRIGGERS: ReadonlySet<string> = new Set([
  'task.status_changed', 'task.assigned', 'task.created', 'task.due_date_passed',
]);
const TASK_ACTIONS: ReadonlySet<string> = new Set(['set_status', 'reassign_task', 'notify_assignee']);

const MAX_RULES_PER_WORKSPACE = 50;

/**
 * Rejects trigger/action combinations that can never do anything (they used to be accepted
 * and then logged 'ok' on every run while silently no-op'ing). Returns an error or null.
 */
function validateRuleCombo(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  actionType: string,
  actionConfig: Record<string, unknown>,
): string | null {
  const isTaskTrigger = TASK_TRIGGERS.has(triggerType);
  if (TASK_ACTIONS.has(actionType) && !isTaskTrigger) {
    return `${actionType} needs a task trigger; ${triggerType} events have no task (use post_webhook instead)`;
  }
  if ((triggerConfig.from_status || triggerConfig.to_status) && triggerType !== 'task.status_changed') {
    return 'from_status/to_status filters only apply to task.status_changed';
  }
  if (triggerConfig.assignee_clerk_id && !isTaskTrigger) {
    return `assignee filter does not apply to ${triggerType}`;
  }
  if (
    actionType === 'set_status' &&
    triggerType === 'task.status_changed' &&
    triggerConfig.to_status &&
    triggerConfig.to_status === actionConfig.status
  ) {
    return 'set_status to the same status the trigger already requires would never change anything';
  }
  return null;
}

/** post_webhook must point at a webhook endpoint of this workspace; returns an error or null. */
async function validateWebhookEndpoint(
  workspaceId: string,
  actionType: string,
  actionConfig: Record<string, unknown>,
): Promise<string | null> {
  if (actionType !== 'post_webhook') return null;
  const endpointId = actionConfig.endpoint_id;
  if (typeof endpointId !== 'string' || !endpointId) return 'post_webhook requires an endpoint';
  const { rows } = await pool.query(
    'SELECT 1 FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2',
    [endpointId, workspaceId],
  );
  return rows.length > 0 ? null : 'Webhook endpoint not found in this workspace';
}

/** reassign_task must target a current workspace member; returns an error message or null. */
async function validateReassignTarget(
  workspaceId: string,
  actionType: string,
  actionConfig: Record<string, unknown>,
): Promise<string | null> {
  if (actionType !== 'reassign_task') return null;
  const assigneeId = actionConfig.assignee_clerk_id;
  if (typeof assigneeId !== 'string' || !assigneeId) return 'reassign_task requires an assignee';
  const { rows } = await pool.query(
    'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
    [workspaceId, assigneeId],
  );
  return rows.length > 0 ? null : 'Assignee is not a member of this workspace';
}

const ruleSchemaBase = z.object({
  name:           z.string().min(1).max(200),
  trigger_type:   z.enum(TRIGGER_TYPES),
  trigger_config: triggerConfigSchema.default({}),
  action_type:    z.enum(ACTION_TYPES),
  action_config:  z.record(z.unknown()).default({}),
  active:         z.boolean().default(true),
});
const ruleSchema = ruleSchemaBase.refine(
  (d) => validateActionConfig(d.action_type, d.action_config) === null,
  (d) => ({ message: validateActionConfig(d.action_type, d.action_config) ?? 'Invalid action_config', path: ['action_config'] }),
);

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
    const ruleError = validateRuleCombo(trigger_type, trigger_config, action_type, action_config)
      ?? await validateReassignTarget(req.workspace.id, action_type, action_config)
      ?? await validateWebhookEndpoint(req.workspace.id, action_type, action_config);
    if (ruleError) { res.status(400).json({ error: ruleError }); return; }

    // Count + insert under a per-workspace xact lock so concurrent creates can't overshoot the cap.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('automation_rules:' || $1::text))", [req.workspace.id]);
      const count = await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM automation_rules WHERE workspace_id = $1',
        [req.workspace.id],
      );
      if ((count.rows[0]?.n ?? 0) >= MAX_RULES_PER_WORKSPACE) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: `A workspace can have at most ${MAX_RULES_PER_WORKSPACE} automation rules` });
        return;
      }
      const { rows } = await client.query(
        `INSERT INTO automation_rules
           (workspace_id, name, trigger_type, trigger_config, action_type, action_config, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.workspace.id, name, trigger_type, trigger_config, action_type, action_config, active, req.auth.userId],
      );
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// PATCH /api/automations/:id  [admin]
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = ruleSchemaBase.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const d = parsed.data;
    if (
      d.action_type !== undefined || d.action_config !== undefined ||
      d.trigger_type !== undefined || d.trigger_config !== undefined
    ) {
      const current = await pool.query<{
        trigger_type: string; trigger_config: Record<string, unknown>;
        action_type: string; action_config: Record<string, unknown>;
      }>(
        `SELECT trigger_type, trigger_config, action_type, action_config
         FROM automation_rules WHERE id = $1 AND workspace_id = $2`,
        [req.params.id, req.workspace.id],
      );
      if (current.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = current.rows[0];
      const effectiveTriggerType   = d.trigger_type   ?? cur.trigger_type;
      const effectiveTriggerConfig = d.trigger_config ?? cur.trigger_config ?? {};
      const effectiveActionType    = d.action_type    ?? cur.action_type;
      const effectiveActionConfig  = d.action_config  ?? cur.action_config ?? {};
      const error = validateActionConfig(effectiveActionType, effectiveActionConfig)
        ?? validateRuleCombo(effectiveTriggerType, effectiveTriggerConfig, effectiveActionType, effectiveActionConfig)
        ?? await validateReassignTarget(req.workspace.id, effectiveActionType, effectiveActionConfig)
        ?? await validateWebhookEndpoint(req.workspace.id, effectiveActionType, effectiveActionConfig);
      if (error) { res.status(400).json({ error }); return; }
    }

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
// Manual trigger for the task.due_date_passed sweep of THIS workspace. The regular sweep runs
// in-process (automationService.startDueDateScheduler, started from index.ts) — an external
// scheduler can't call this route since it requires a Clerk admin session.
// Claims up to 200 newly-overdue tasks atomically (same claim-then-dispatch as the scheduler,
// so it can't double-dispatch against it), responds immediately, and dispatches in the
// background: post_webhook actions can take over a minute with retries, which previously kept
// this request open until the proxy timed it out. dispatchDueDatePassed registers itself with
// trackBackground, so a graceful shutdown waits for it.
router.post('/due-date-check', requireAdmin, async (req, res, next) => {
  try {
    const claimed = await claimOverdueTasks(req.workspace.id, 200);
    dispatchDueDatePassed(claimed).catch(() => {});
    res.json({ ok: true, dispatched: claimed.length });
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
