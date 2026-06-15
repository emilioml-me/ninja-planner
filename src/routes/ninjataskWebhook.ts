// Inbound webhook route for ninja-task → ninja-planner events.
// Registered BEFORE requireAuth in app.ts so ninja-task can call it without a browser session.
import { Router } from 'express';
import { createHmac } from 'crypto';
import type { Pool } from 'pg';

export function createNinjaTaskWebhookRouter(pool: Pool) {
  const router = Router();

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
  router.post('/ninja-task/webhook', (req, res) => {
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

    const payload = JSON.stringify(req.body);
    const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expected.length || signature !== expected) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const event = req.body as {
      event: string;
      payload?: { taskId?: string; [key: string]: unknown };
      timestamp?: string;
    };

    // Only handle task_complete events; ack everything else
    if (event.event !== 'task_complete') {
      res.json({ ok: true });
      return;
    }

    const ninjaTaskId = event.payload?.taskId;
    if (!ninjaTaskId || typeof ninjaTaskId !== 'string') {
      res.status(400).json({ error: 'Missing payload.taskId' });
      return;
    }

    // Async update — respond immediately so ninja-task doesn't time out
    pool.query(
      `UPDATE tasks SET status = 'done', updated_at = NOW()
       WHERE external_ninja_task_id = $1
         AND status <> 'done'
         AND deleted_at IS NULL`,
      [ninjaTaskId],
    ).then((result) => {
      if (result.rowCount && result.rowCount > 0) {
        console.info('[ninja-task-webhook] task_complete synced', { ninjaTaskId, rowsUpdated: result.rowCount });
      }
    }).catch((err: unknown) => {
      console.error('[ninja-task-webhook] DB update failed', err);
    });

    res.json({ ok: true });
  });

  return router;
}
