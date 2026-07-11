// Inbound webhook route for ninja-task → ninja-planner events.
// Registered BEFORE requireAuth in app.ts so ninja-task can call it without a browser session.
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';

export function createNinjaTaskWebhookRouter(pool: Pool) {
  const router = Router();

  // Tighter than the global 200/min limiter — this is a public, unauthenticated-until-HMAC
  // endpoint that triggers a DB write on every request.
  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  /**
   * POST /api/integrations/ninja-task/webhook
   *
   * Receives events from ninja-task (currently: task_complete).
   * ninja-task sends:
   *   Header:  X-NinjaTask-Signature: sha256=<hmac-hex>
   *   Body:    { event, payload: { taskId, taskTitle, ... }, timestamp }
   *
   * When a task is completed in ninja-task, the matching planner task (linked
   * via external_ninja_task_id) is moved to status='done'.
   */
  router.post('/ninja-task/webhook', webhookLimiter, (req, res) => {
    const secret = process.env.NINJA_TASK_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    // Verify HMAC-SHA256 signature
    const signature = req.headers['x-ninjatask-signature'] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: 'Missing X-NinjaTask-Signature header' });
      return;
    }

    // req.body is the raw Buffer here (mounted with express.raw() in app.ts, ahead of the global
    // express.json()) so the signature is verified over the exact bytes ninja-task signed — a
    // JSON.stringify(parsedBody) re-serialization can diverge in number formatting, whitespace,
    // or key order and reject a legitimately-signed request.
    const rawBody = req.body as Buffer;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

    // Constant-time comparison to prevent timing attacks — the previous `!==` string compare
    // here was NOT actually timing-safe despite the comment; timingSafeEqual requires equal-
    // length buffers, so the length check must short-circuit before it (mismatched lengths
    // would otherwise throw).
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let event: { event: string; payload?: { taskId?: string; questId?: string; [key: string]: unknown }; timestamp?: string };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    if (event.event === 'quest_complete') {
      const questId = event.payload?.questId;
      if (!questId || typeof questId !== 'string') {
        res.status(400).json({ error: 'Missing payload.questId' });
        return;
      }

      // Map the completed quest back to (sprint, member) via sprint_quests, then let the member's
      // workspace admins know — there's no per-sprint "done" state to flip here since a quest
      // only represents one member's personal copy of the sprint, not the sprint itself.
      // Matching on ninja_task_quest_id alone (no workspace_id in the payload) is safe here,
      // unlike the cross-tenant bug fixed for external_ninja_task_id: that column has no
      // uniqueness constraint, but sprint_quests_quest_id_unique (migration 047) makes
      // ninja_task_quest_id globally unique, and each row's (workspace_id, sprint_id,
      // clerk_user_id) is set once by our own code at quest-creation time — an incoming questId
      // can therefore only ever resolve to the single workspace that created it.
      pool.query<{ sprint_id: string; workspace_id: string; clerk_user_id: string }>(
        `UPDATE sprint_quests SET completed_at = now()
         WHERE ninja_task_quest_id = $1 AND completed_at IS NULL
         RETURNING sprint_id, workspace_id, clerk_user_id`,
        [questId],
      ).then(async (result) => {
        const row = result.rows[0];
        if (!row) return;

        const sprintResult = await pool.query<{ name: string }>(
          'SELECT name FROM sprints WHERE id = $1', [row.sprint_id],
        );
        const sprintName = sprintResult.rows[0]?.name ?? 'sprint';

        const { createNotification } = await import('../services/notificationService.js');
        const admins = await pool.query<{ clerk_user_id: string }>(
          "SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 AND role IN ('owner','admin')",
          [row.workspace_id],
        );
        for (const admin of admins.rows) {
          createNotification({
            workspaceId: row.workspace_id,
            recipientClerkId: admin.clerk_user_id,
            type: 'automation',
            title: `A teammate completed their "${sprintName}" quest`,
            link: '/sprints',
          }).catch(() => {});
        }
        console.info('[ninja-task-webhook] quest_complete synced', { questId, sprintId: row.sprint_id });
      }).catch((err: unknown) => {
        console.error('[ninja-task-webhook] quest_complete DB update failed', err);
      });

      res.json({ ok: true });
      return;
    }

    // Only handle task_complete/quest_complete events; ack everything else
    if (event.event !== 'task_complete') {
      res.json({ ok: true });
      return;
    }

    const ninjaTaskId = event.payload?.taskId;
    if (!ninjaTaskId || typeof ninjaTaskId !== 'string') {
      res.status(400).json({ error: 'Missing payload.taskId' });
      return;
    }

    // Respond immediately so ninja-task doesn't time out; the actual sync (including every
    // completion side effect) runs fire-and-forget below.
    (async () => {
      const found = await pool.query<{ id: string; workspace_id: string; status: string }>(
        `SELECT id, workspace_id, status FROM tasks
         WHERE external_ninja_task_id = $1 AND deleted_at IS NULL`,
        [ninjaTaskId],
      );
      const row = found.rows[0];
      if (!row || row.status === 'done') return;

      // Previously did a raw UPDATE tasks SET status='done' here, which skipped every completion
      // side effect PATCH /api/tasks/:id fires: no task.completed webhook, no automation
      // dispatch, no goal-milestone check, no watcher notifications. Route through the same
      // service PATCH uses instead so ninja-task-driven completions behave identically.
      const { updateTaskWithPrevState } = await import('../services/taskService.js');
      const updateResult = await updateTaskWithPrevState(row.id, row.workspace_id, { status: 'done' });
      if (!updateResult) return;
      const { task, prevStatus } = updateResult;

      const { fireWebhooks } = await import('../services/webhookService.js');
      fireWebhooks(row.workspace_id, 'task.completed', { task });

      const { dispatchAutomations } = await import('../services/automationService.js');
      if (prevStatus && prevStatus !== task.status) {
        dispatchAutomations({
          type: 'task.status_changed',
          workspaceId: row.workspace_id,
          taskId: task.id,
          oldStatus: prevStatus,
          newStatus: task.status,
          assigneeId: task.assignee_clerk_id,
        }).catch(() => {});
      }

      const { checkAndNotifyGoalMilestones } = await import('../services/goalService.js');
      checkAndNotifyGoalMilestones(task.id, row.workspace_id, process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com');

      const { createNotification } = await import('../services/notificationService.js');
      const watchers = await pool.query<{ user_clerk_id: string }>(
        'SELECT user_clerk_id FROM task_watchers WHERE task_id = $1 AND workspace_id = $2',
        [task.id, row.workspace_id],
      );
      for (const { user_clerk_id } of watchers.rows) {
        createNotification({
          workspaceId: row.workspace_id,
          recipientClerkId: user_clerk_id,
          type: 'task_updated',
          title: `Task updated: "${task.title}"`,
          body: `A task you're watching was updated.`,
          link: '/tasks',
        }).catch(() => {});
      }

      console.info('[ninja-task-webhook] task_complete synced', { ninjaTaskId, taskId: task.id });
    })().catch((err: unknown) => {
      console.error('[ninja-task-webhook] task_complete sync failed', err);
    });

    res.json({ ok: true });
  });

  return router;
}
