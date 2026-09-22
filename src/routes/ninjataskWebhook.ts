// Inbound webhook route for ninja-task → ninja-planner events.
// Registered BEFORE requireAuth in app.ts so ninja-task can call it without a browser session.
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';

const REPLAY_WINDOW_MS = 5 * 60_000;

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
    // A missing body or a non-matching Content-Type (express.raw only buffers the configured
    // type) leaves req.body as undefined/{} instead of a Buffer; createHmac().update() would throw
    // on that and surface as a 500.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Missing or invalid request body' });
      return;
    }
    const rawBody = req.body;
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

    let event: { event: string; payload?: { taskId?: string; questId?: string; [key: string]: unknown }; timestamp?: string | number };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') {
      res.status(400).json({ error: 'Invalid event payload' });
      return;
    }

    // Replay protection: the signed body carries ninja-task's send time (ISO string). Without
    // this check a captured, validly-signed request could be replayed indefinitely.
    const sentAt = typeof event.timestamp === 'string' || typeof event.timestamp === 'number'
      ? new Date(event.timestamp).getTime()
      : NaN;
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > REPLAY_WINDOW_MS) {
      res.status(400).json({ error: 'Missing or stale timestamp' });
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
          "SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 AND role IN ('org:owner','org:admin')",
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

      // Same update service + transition side effects as PATCH /api/tasks/:id (activity row,
      // recurring spawn, task.completed webhook, automations, goal milestones, watchers).
      const { updateTaskWithPrevState } = await import('../services/taskService.js');
      const updateResult = await updateTaskWithPrevState(row.id, row.workspace_id, { status: 'done' });
      if (!updateResult) return;
      const { task, prevStatus } = updateResult;

      // A retried webhook can pass the `row.status === 'done'` pre-check before the first
      // request commits, then serialize behind its row lock; runTaskStatusEffects is a no-op when
      // prevStatus already equals the new status, so no duplicate side effects fire.
      const { runTaskStatusEffects } = await import('../services/taskStatusEffects.js');
      await runTaskStatusEffects({
        workspaceId: row.workspace_id,
        actorUserId: null,
        task,
        prevStatus,
        newStatus: task.status,
        source: 'ninjatask',
      });

      console.info('[ninja-task-webhook] task_complete synced', { ninjaTaskId, taskId: task.id });
    })().catch((err: unknown) => {
      console.error('[ninja-task-webhook] task_complete sync failed', err);
    });

    res.json({ ok: true });
  });

  return router;
}
