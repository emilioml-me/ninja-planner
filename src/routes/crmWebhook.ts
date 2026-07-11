// Inbound webhook route for crm-ninja -> ninja-planner client sync.
// Registered BEFORE requireAuth in app.ts so crm-ninja can call it without a browser session.
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';

const VALID_STAGES = new Set(['prospect', 'proposal', 'active', 'churned']);

export function createCrmWebhookRouter(pool: Pool) {
  const router = Router();

  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  });

  /**
   * POST /api/integrations/crm/webhook
   *
   * Receives client/deal events from crm-ninja.
   * crm-ninja sends:
   *   Header: X-Crm-Signature: sha256=<hmac-hex>
   *   Body:   {
   *     event: 'client.upserted',
   *     workspaceId: string,           // planner workspace this client belongs to
   *     payload: {
   *       externalCrmId: string,       // crm-ninja's own id for this client/deal
   *       name: string,
   *       stage?: 'prospect' | 'active' | 'churned',
   *       mrr?: number,
   *       contactName?: string,
   *       contactEmail?: string,
   *     },
   *     timestamp: string,
   *   }
   *
   * Unlike the ninja-task webhook (which matches purely by a global external id — the exact
   * cross-tenant bug fixed for tasks earlier in this project), the CRM payload must carry an
   * explicit workspaceId and every DB write is scoped to it, since the same externalCrmId could
   * otherwise collide across two unrelated workspaces' CRM data.
   */
  router.post('/crm/webhook', webhookLimiter, (req, res) => {
    const secret = process.env.CRM_WEBHOOK_SECRET;
    if (!secret) {
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const signature = req.headers['x-crm-signature'] as string | undefined;
    if (!signature) {
      res.status(401).json({ error: 'Missing X-Crm-Signature header' });
      return;
    }

    // req.body is the raw Buffer here (mounted with express.raw() in app.ts, ahead of the global
    // express.json()) so the signature is verified over the exact bytes crm-ninja signed, not a
    // JSON.stringify(parsedBody) re-serialization that can diverge in formatting and reject a
    // legitimately-signed request.
    const rawBody = req.body as Buffer;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let event: {
      event?: string;
      workspaceId?: string;
      payload?: {
        externalCrmId?: string;
        name?: string;
        stage?: string;
        mrr?: number;
        contactName?: string;
        contactEmail?: string;
      };
    };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    if (event.event !== 'client.upserted') {
      res.json({ ok: true });
      return;
    }

    const workspaceId = event.workspaceId;
    const externalCrmId = event.payload?.externalCrmId;
    const name = event.payload?.name;
    if (!workspaceId || !externalCrmId || !name) {
      res.status(400).json({ error: 'Missing workspaceId, payload.externalCrmId, or payload.name' });
      return;
    }
    const stage = event.payload?.stage && VALID_STAGES.has(event.payload.stage) ? event.payload.stage : undefined;

    // Verify the workspace actually exists before writing — a malformed or stale workspaceId
    // should not silently create an orphaned client row.
    pool.query('SELECT 1 FROM workspaces WHERE id = $1', [workspaceId])
      .then((wsCheck) => {
        if (wsCheck.rows.length === 0) {
          res.status(404).json({ error: 'Workspace not found' });
          return;
        }
        return pool.query(
          `INSERT INTO clients (workspace_id, external_crm_id, name, stage, mrr, contact_name, contact_email)
           VALUES ($1, $2, $3, COALESCE($4, 'prospect'), COALESCE($5, 0), $6, $7)
           ON CONFLICT (workspace_id, external_crm_id) WHERE external_crm_id IS NOT NULL DO UPDATE SET
             name          = EXCLUDED.name,
             stage         = COALESCE($4, clients.stage),
             mrr           = COALESCE($5, clients.mrr),
             contact_name  = COALESCE($6, clients.contact_name),
             contact_email = COALESCE($7, clients.contact_email),
             updated_at    = now()`,
          [
            workspaceId, externalCrmId, name, stage ?? null,
            event.payload?.mrr ?? null, event.payload?.contactName ?? null, event.payload?.contactEmail ?? null,
          ],
        ).then(() => {
          console.info('[crm-webhook] client.upserted synced', { workspaceId, externalCrmId });
          res.json({ ok: true });
        });
      })
      .catch((err: unknown) => {
        console.error('[crm-webhook] DB write failed', err);
        res.status(500).json({ error: 'Internal error' });
      });
  });

  return router;
}
