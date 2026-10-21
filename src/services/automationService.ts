// Automation event dispatcher — called from task route event points
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { deliverToEndpoint, fireWebhooks } from './webhookService.js';
import { updateTaskWithPrevState, logTaskActivity, type Task } from './taskService.js';
import { runTaskStatusEffects } from './taskStatusEffects.js';
import { createNotification } from './notificationService.js';
import { trackBackground } from '../lib/background.js';

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

/** 'skipped' = the action legitimately had nothing to do (logged with the reason, not as 'ok'). */
type ActionOutcome = { result: 'ok' } | { result: 'skipped'; reason: string };
const OK: ActionOutcome = { result: 'ok' };
const skipped = (reason: string): ActionOutcome => ({ result: 'skipped', reason });

async function executeAction(
  rule: { id: string; action_type: string; action_config: Record<string, unknown>; workspace_id: string },
  trigger: AutomationTrigger,
): Promise<ActionOutcome> {
  const cfg = rule.action_config;
  const taskId = 'taskId' in trigger ? trigger.taskId : null;

  switch (rule.action_type) {
    case 'set_status': {
      const status = cfg.status as string;
      if (!taskId) return skipped(`set_status: trigger ${trigger.type} has no task`);
      if (!status) return skipped('set_status: no status configured');
      // Same service + side-effect helper as PATCH /api/tasks/:id, so an automation-driven
      // status change behaves identically (activity row, recurring spawn, webhooks, goal
      // milestones, watchers). source 'automation' suppresses re-dispatching
      // task.status_changed, which would otherwise let two rules loop forever.
      const updateResult = await updateTaskWithPrevState(taskId, rule.workspace_id, { status });
      if (!updateResult) throw new Error(`set_status: task ${taskId} not found`);
      const { task, prevStatus } = updateResult;
      const changed = await runTaskStatusEffects({
        workspaceId: rule.workspace_id,
        actorUserId: null,
        task,
        prevStatus,
        newStatus: task.status,
        source: 'automation',
      });
      return changed ? OK : skipped(`set_status: task already ${status}`);
    }
    case 'reassign_task': {
      const assigneeId = cfg.assignee_clerk_id as string;
      if (!taskId) return skipped(`reassign_task: trigger ${trigger.type} has no task`);
      if (!assigneeId) return skipped('reassign_task: no assignee configured');
      // The target must be a current workspace member (validated at rule creation too, but a
      // member can leave after the rule was created). 0 rows = failed run, not a silent 'ok'.
      // Only writes when the assignee actually changes.
      const { rows } = await pool.query<Task & { prev_assignee: string | null; is_member: boolean }>(
        `WITH prev AS (
           SELECT id, assignee_clerk_id FROM tasks
           WHERE id = $2 AND workspace_id = $3 AND deleted_at IS NULL
           FOR UPDATE
         ), member AS (
           SELECT EXISTS (
             SELECT 1 FROM workspace_members WHERE workspace_id = $3 AND clerk_user_id = $1
           ) AS ok
         ), upd AS (
           UPDATE tasks t SET assignee_clerk_id = $1
           FROM prev, member
           WHERE t.id = prev.id
             AND member.ok
             AND prev.assignee_clerk_id IS DISTINCT FROM $1
           RETURNING t.*
         )
         SELECT upd.*, prev.assignee_clerk_id AS prev_assignee, member.ok AS is_member
         FROM prev CROSS JOIN member LEFT JOIN upd ON upd.id = prev.id`,
        [assigneeId, taskId, rule.workspace_id],
      );
      const row = rows[0];
      if (!row || !row.is_member) {
        throw new Error(`reassign_task: task not found or ${assigneeId} is not a member of this workspace`);
      }
      if (row.prev_assignee === assigneeId || !row.id) {
        return skipped('reassign_task: task already assigned to that member');
      }
      // Same effects a manual reassignment has (activity row, task.updated webhook, assignee
      // notification). task.assigned automations are deliberately not re-dispatched so two
      // reassign rules can't loop.
      const { prev_assignee: _prev, is_member: _member, ...task } = row;
      await logTaskActivity(task.id, 'system:automation', 'updated', { assignee_clerk_id: assigneeId });
      fireWebhooks(rule.workspace_id, 'task.updated', { task });
      createNotification({
        workspaceId: rule.workspace_id,
        recipientClerkId: assigneeId,
        type: 'task_assigned',
        title: `You were assigned "${task.title}"`,
        link: `/tasks?task=${task.id}`,
      }).catch(() => {});
      return OK;
    }
    case 'notify_assignee': {
      const assigneeId = 'assigneeId' in trigger ? trigger.assigneeId : null;
      if (!assigneeId) return skipped('notify_assignee: no assignee on this event');
      const title = (cfg.title as string | undefined) ?? 'Automation triggered';
      const body  = (cfg.message as string | undefined) ?? undefined;
      const link  = taskId ? `/tasks?task=${taskId}` : undefined;
      const inserted = await pool.query(
        `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
         SELECT $1,$2,'automation',$3,$4,$5
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_preferences
           WHERE workspace_id = $1 AND clerk_user_id = $2 AND type = 'automation' AND enabled = false
         )`,
        [rule.workspace_id, assigneeId, title, body ?? null, link ?? null],
      );
      return (inserted.rowCount ?? 0) > 0 ? OK : skipped('notify_assignee: recipient muted automation notifications');
    }
    case 'post_webhook': {
      // Delivers through a registered Webhook endpoint (chosen by the rule) instead of a raw
      // URL typed into the automation config — reuses the same HMAC signing, 3-attempt retry,
      // and webhook_deliveries logging that regular event-subscription webhooks get, rather
      // than a bare unsigned, non-retrying, unaudited fetch.
      const endpointId = cfg.endpoint_id as string;
      if (!endpointId) return skipped('post_webhook: no endpoint configured');
      const result = await deliverToEndpoint(endpointId, rule.workspace_id, trigger.type, { trigger, rule_id: rule.id });
      if (result === 'not_found') {
        const existing = await pool.query<{ active: boolean }>(
          'SELECT active FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2',
          [endpointId, rule.workspace_id],
        );
        throw new Error(
          existing.rows.length > 0
            ? `post_webhook: webhook endpoint ${endpointId} is disabled; enable it on the Webhooks page or pick another endpoint`
            : `post_webhook: webhook endpoint ${endpointId} no longer exists; edit this rule to pick another endpoint`,
        );
      }
      // Previously `deliverToEndpoint` returned a plain boolean that was true whenever the
      // endpoint existed, regardless of whether the HTTP delivery itself ultimately succeeded —
      // so a rule pointed at a permanently-failing endpoint logged 'ok' on every run. Throwing
      // here on 'failed' makes dispatchAutomations' catch block log 'error' instead, matching
      // the endpoint's actual delivery outcome (also visible in webhook_deliveries).
      if (result === 'failed') {
        throw new Error(`post_webhook: delivery to endpoint ${endpointId} failed after retries`);
      }
      return OK;
    }
    default:
      logger.warn({ rule_id: rule.id, action: rule.action_type }, 'Unknown automation action type');
      return skipped(`unknown action type ${rule.action_type}`);
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

/**
 * Runs every active matching rule for the event. Never throws. Callers fire-and-forget it, so
 * the work is registered with trackBackground and graceful shutdown waits for it.
 */
export function dispatchAutomations(event: AutomationTrigger): Promise<void> {
  return trackBackground(runAutomations(event));
}

async function runAutomations(event: AutomationTrigger): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT id, workspace_id, trigger_type, trigger_config, action_type, action_config
       FROM automation_rules
       WHERE workspace_id = $1 AND active = true AND trigger_type = $2`,
      [event.workspaceId, event.type],
    );

    // Run all matching rules concurrently rather than sequentially — a slow/hanging
    // post_webhook action (up to ~94s worst case across its retry/backoff schedule) previously
    // stalled every other rule for the same event, including fast ones like notify_assignee,
    // since the loop awaited each rule's executeAction fully before starting the next.
    await Promise.all(rows.map(async (rule) => {
      // Non-matching rules are not logged: a 'skipped' row for every rule on every event
      // flooded automation_logs and buried the runs admins actually care about.
      if (!triggerMatches(rule, event)) return;
      try {
        const outcome = await executeAction(rule, event);
        if (outcome.result === 'skipped') {
          await logRun(rule.id, rule.workspace_id, event, 'skipped', outcome.reason);
        } else {
          await logRun(rule.id, rule.workspace_id, event, 'ok');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ rule_id: rule.id, err }, 'Automation action failed');
        await logRun(rule.id, rule.workspace_id, event, 'error', msg);
      }
    }));
  } catch (err) {
    logger.error({ err, event }, 'dispatchAutomations failed');
  }
}

// --- task.due_date_passed scheduler -------------------------------------------------------
// Previously this trigger only fired from POST /api/automations/due-date-check, which needs a
// Clerk admin JWT; no external scheduler can hold one, so the trigger never fired in practice.
// It now runs in-process on an interval. Safety:
//  - claim-then-dispatch: each overdue task is atomically stamped (due_date_passed_notified_at)
//    in the same UPDATE ... RETURNING that selects it, so concurrent claimers never share it;
//    after dispatch due_date_passed_dispatched_at confirms it, and an unconfirmed claim older
//    than DUE_DATE_STALE_CLAIM is re-claimed (a restart mid-dispatch no longer loses it);
//  - small batches (FOR UPDATE SKIP LOCKED) so a large backlog never holds long locks;
//  - each batch is claimed inside a transaction holding pg_try_advisory_xact_lock (so only one
//    container sweeps at a time, PgBouncer-safe), committed, then dispatched outside it.

const DUE_DATE_SCHEDULER_LOCK_KEY = 72_310_451; // arbitrary constant, unique to this job
const DUE_DATE_BATCH_SIZE = 50;
const DUE_DATE_MAX_BATCHES_PER_RUN = 40;

export interface ClaimedOverdueTask {
  id: string;
  workspace_id: string;
  title: string;
  assignee_clerk_id: string | null;
}

// A claim (due_date_passed_notified_at) older than this whose dispatch was never confirmed
// (due_date_passed_dispatched_at, migration 065) is treated as lost - e.g. the process died
// mid-dispatch - and re-claimed. Well above the worst-case post_webhook retry time (~70s).
const DUE_DATE_STALE_CLAIM = '15 minutes';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Atomically claims up to `limit` newly-overdue tasks (optionally for one workspace), plus
 * tasks whose earlier claim went stale without a confirmed dispatch. The claim stamp is set in
 * the same UPDATE that selects the rows, so concurrent claimers never get the same task.
 */
export async function claimOverdueTasks(
  workspaceId: string | null,
  limit = DUE_DATE_BATCH_SIZE,
  db: Queryable = pool,
): Promise<ClaimedOverdueTask[]> {
  const { rows } = await db.query<ClaimedOverdueTask>(
    `UPDATE tasks SET due_date_passed_notified_at = now()
     WHERE id IN (
       SELECT id FROM tasks
       WHERE ($1::uuid IS NULL OR workspace_id = $1::uuid)
         AND status <> 'done'
         AND deleted_at IS NULL
         AND due_date < CURRENT_DATE
         AND (
           due_date_passed_notified_at IS NULL
           OR (
             due_date_passed_notified_at < now() - $3::interval
             AND (due_date_passed_dispatched_at IS NULL
                  OR due_date_passed_dispatched_at < due_date_passed_notified_at)
           )
         )
       ORDER BY due_date
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, workspace_id, title, assignee_clerk_id`,
    [workspaceId, limit, DUE_DATE_STALE_CLAIM],
  );
  return rows;
}

/**
 * Dispatches task.due_date_passed for already-claimed tasks, then confirms each dispatch so the
 * claim is final. A crash before confirmation lets a later sweep re-claim the task
 * (at-least-once rather than silently losing it). Never throws.
 */
export function dispatchDueDatePassed(tasks: ClaimedOverdueTask[]): Promise<void> {
  return trackBackground(Promise.all(tasks.map(async (task) => {
    await dispatchAutomations({
      type: 'task.due_date_passed',
      workspaceId: task.workspace_id,
      taskId: task.id,
      assigneeId: task.assignee_clerk_id,
      title: task.title,
    });
    await pool.query(
      `UPDATE tasks SET due_date_passed_dispatched_at = now()
       WHERE id = $1 AND due_date_passed_notified_at IS NOT NULL`,
      [task.id],
    ).catch((err) => logger.warn({ err, taskId: task.id }, '[automationService] due-date dispatch confirm failed'));
  })).then(() => undefined));
}

/**
 * Claims one batch under a transaction-scoped try-lock (safe behind PgBouncer transaction
 * pooling, unlike a session-level advisory lock whose unlock can land on another backend).
 * Returns null when another process holds the lock. The pooled client is released before the
 * caller dispatches, so slow webhook retries never pin a connection.
 */
async function claimBatchLocked(): Promise<ClaimedOverdueTask[] | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockResult = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [DUE_DATE_SCHEDULER_LOCK_KEY],
    );
    if (lockResult.rows[0]?.locked !== true) {
      await client.query('ROLLBACK');
      return null;
    }
    const claimed = await claimOverdueTasks(null, DUE_DATE_BATCH_SIZE, client);
    await client.query('COMMIT');
    return claimed;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One sweep across all workspaces; batches are claimed under the advisory lock, dispatched outside it. */
export async function runDueDateSweep(): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < DUE_DATE_MAX_BATCHES_PER_RUN; batch++) {
    if (stopping) break;
    const claimed = await claimBatchLocked();
    if (!claimed || claimed.length === 0) break;
    total += claimed.length;
    await dispatchDueDatePassed(claimed);
    if (claimed.length < DUE_DATE_BATCH_SIZE) break;
  }
  return total;
}

let dueDateTimer: NodeJS.Timeout | null = null;
let dueDateFirstRun: NodeJS.Timeout | null = null;
let stopping = false;

/** Stops the scheduler (graceful shutdown). An in-flight sweep finishes its current batch. */
export function stopDueDateScheduler(): void {
  stopping = true;
  if (dueDateFirstRun) { clearTimeout(dueDateFirstRun); dueDateFirstRun = null; }
  if (dueDateTimer) { clearInterval(dueDateTimer); dueDateTimer = null; }
}

/**
 * Starts the in-process due-date sweep (default every 15 min, first run ~30s after boot).
 * Disabled under NODE_ENV=test or DUE_DATE_SCHEDULER_DISABLED=true. Idempotent.
 */
export function startDueDateScheduler(
  intervalMs = Number(process.env.DUE_DATE_SCHEDULER_INTERVAL_MS) || 15 * 60_000,
): void {
  if (dueDateTimer || process.env.NODE_ENV === 'test' || process.env.DUE_DATE_SCHEDULER_DISABLED === 'true') return;
  stopping = false;
  let running = false;
  const tick = () => {
    if (running || stopping) return;
    running = true;
    runDueDateSweep()
      .then((count) => {
        if (count > 0) logger.info({ count }, '[automationService] due-date sweep dispatched');
      })
      .catch((err) => logger.error({ err }, '[automationService] due-date sweep failed'))
      .finally(() => { running = false; });
  };
  dueDateFirstRun = setTimeout(tick, 30_000);
  dueDateFirstRun.unref();
  dueDateTimer = setInterval(tick, Math.max(intervalMs, 60_000));
  dueDateTimer.unref();
}
