// Automation event dispatcher — called from task route event points
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { deliverToEndpoint } from './webhookService.js';

export type AutomationTrigger =
  | { type: 'task.status_changed'; workspaceId: string; taskId: string; oldStatus: string; newStatus: string; assigneeId?: string | null }
  | { type: 'task.assigned';       workspaceId: string; taskId: string; assigneeId: string; title: string }
  | { type: 'task.created';        workspaceId: string; taskId: string; assigneeId?: string | null; title: string }
  | { type: 'task.due_date_passed'; workspaceId: string; taskId: string; assigneeId?: string | null; title: string }
  | { type: 'sprint.completed';    workspaceId: string; sprintId: string; title: string }
  | { type: 'epic.completed';      workspaceId: string; epicId: string; title: string }
  | { type: 'goal.completed';      workspaceId: string; goalId: string; title: string };

async function logRun(
  ruleId: string,
  workspaceId: string,
  payload: unknown,
  result: 'ok' | 'error' | 'skipped',
  errorMessage?: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO automation_logs (rule_id, workspace_id, trigger_payload, result, error_message)
       VALUES ($1,$2,$3,$4,$5)`,
      [ruleId, workspaceId, JSON.stringify(payload), result, errorMessage ?? null],
    );
  } catch (err) {
    // Best-effort logging, but a swallowed failure here previously left no trace at all —
    // making "why are automation logs missing" undiagnosable.
    logger.warn({ err, ruleId, workspaceId }, '[automationService] logRun insert failed');
  }
}

async function executeAction(
  rule: { id: string; action_type: string; action_config: Record<string, unknown>; workspace_id: string },
  trigger: AutomationTrigger,
): Promise<void> {
  const cfg = rule.action_config;
  const taskId = 'taskId' in trigger ? trigger.taskId : null;

  switch (rule.action_type) {
    case 'set_status': {
      const status = cfg.status as string;
      if (!taskId || !status) break;
      await pool.query(
        `UPDATE tasks SET status = $1 WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL`,
        [status, taskId, rule.workspace_id],
      );
      break;
    }
    case 'reassign_task': {
      const assigneeId = cfg.assignee_clerk_id as string;
      if (!taskId || !assigneeId) break;
      // Every other assignment path in this codebase (routes/tasks.ts, routes/csvImport.ts)
      // verifies the target is actually a workspace member before assigning — this one didn't,
      // so a misconfigured automation rule could silently assign to an arbitrary external id.
      await pool.query(
        `UPDATE tasks SET assignee_clerk_id = $1
         WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM workspace_members
             WHERE workspace_id = $3 AND clerk_user_id = $1
           )`,
        [assigneeId, taskId, rule.workspace_id],
      );
      break;
    }
    case 'notify_assignee': {
      const assigneeId = 'assigneeId' in trigger ? trigger.assigneeId : null;
      if (!assigneeId) break;
      const title = (cfg.title as string | undefined) ?? 'Automation triggered';
      const body  = (cfg.message as string | undefined) ?? undefined;
      const link  = taskId ? `/tasks?highlight=${taskId}` : undefined;
      await pool.query(
        `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
         SELECT $1,$2,'automation',$3,$4,$5
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_preferences
           WHERE workspace_id = $1 AND clerk_user_id = $2 AND type = 'automation' AND enabled = false
         )`,
        [rule.workspace_id, assigneeId, title, body ?? null, link ?? null],
      );
      break;
    }
    case 'post_webhook': {
      // Delivers through a registered Webhook endpoint (chosen by the rule) instead of a raw
      // URL typed into the automation config — reuses the same HMAC signing, 3-attempt retry,
      // and webhook_deliveries logging that regular event-subscription webhooks get, rather
      // than a bare unsigned, non-retrying, unaudited fetch.
      const endpointId = cfg.endpoint_id as string;
      if (!endpointId) break;
      const delivered = await deliverToEndpoint(endpointId, rule.workspace_id, trigger.type, { trigger, rule_id: rule.id });
      if (!delivered) {
        throw new Error(`post_webhook: endpoint ${endpointId} not found or inactive`);
      }
      break;
    }
    default:
      logger.warn({ rule_id: rule.id, action: rule.action_type }, 'Unknown automation action type');
  }
}

function triggerMatches(rule: { trigger_type: string; trigger_config: Record<string, unknown> }, event: AutomationTrigger): boolean {
  if (rule.trigger_type !== event.type) return false;
  const cfg = rule.trigger_config;

  if (event.type === 'task.status_changed') {
    if (cfg.from_status && cfg.from_status !== event.oldStatus) return false;
    if (cfg.to_status   && cfg.to_status   !== event.newStatus) return false;
  }
  // assignee_clerk_id filter applies to every trigger type that carries an assigneeId — this
  // used to be silently ignored for anything other than task.status_changed, so a rule scoped
  // to "only when assigned to user X" actually fired for every assignee.
  if ('assigneeId' in event && cfg.assignee_clerk_id && cfg.assignee_clerk_id !== event.assigneeId) {
    return false;
  }
  return true;
}

export async function dispatchAutomations(event: AutomationTrigger): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, trigger_type, trigger_config, action_type, action_config
       FROM automation_rules
       WHERE workspace_id = $1 AND active = true AND trigger_type = $2`,
      [event.workspaceId, event.type],
    );

    for (const rule of rows) {
      if (!triggerMatches(rule, event)) {
        await logRun(rule.id, rule.workspace_id, event, 'skipped');
        continue;
      }
      try {
        await executeAction(rule, event);
        await logRun(rule.id, rule.workspace_id, event, 'ok');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ rule_id: rule.id, err }, 'Automation action failed');
        await logRun(rule.id, rule.workspace_id, event, 'error', msg);
      }
    }
  } catch (err) {
    logger.error({ err, event }, 'dispatchAutomations failed');
  }
}
