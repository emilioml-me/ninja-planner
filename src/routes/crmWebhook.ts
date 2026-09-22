// Inbound webhook route for crm-ninja -> ninja-planner client sync.
// Registered BEFORE requireAuth in app.ts so crm-ninja can call it without a browser session.
import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { z } from 'zod';

/** Deliveries older than this (or dated in the future beyond the same skew) are rejected as replays. */
const MAX_EVENT_AGE_MS = 5 * 60_000;

// Unknown stage values are dropped (keep the existing stage) rather than failing the delivery.
const stageSchema = z.enum(['prospect', 'proposal', 'active', 'churned']);

const eventSchema = z.object({
  event:       z.string().max(100),
  workspaceId: z.string().uuid(),
  // crm-ninja user id owning the contact; must match workspaces.crm_ninja_tenant_id.
  tenantId:    z.number().int().positive(),
  timestamp:   z.string().max(64),
  payload: z.object({
    externalCrmId: z.string().min(1).max(255),
    name:          z.string().trim().min(1).max(255),
    stage:         z.string().max(50).optional().nullable(),
    // clients.mrr is numeric(12,2)
    mrr:           z.number().finite().min(0).max(9_999_999_999.99).optional().nullable(),
    contactName:   z.string().max(255).optional().nullable(),
    contactEmail:  z.string().email().max(255).optional().nullable(),
  }),
});

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
   *     tenantId: number,              // crm-ninja user id; must equal workspaces.crm_ninja_tenant_id
   *     payload: {
   *       externalCrmId: string,       // crm-ninja's own id for this client/deal
   *       name: string,
   *       stage?: 'prospect' | 'active' | 'churned',
   *       mrr?: number,
   *       contactName?: string,
   *       contactEmail?: string,
   *     },
   *     timestamp: string,             // ISO; rejected if older than 5 minutes (replay guard)
   *   }
   *
   * Unlike the ninja-task webhook (which matches purely by a global external id — the exact
   * cross-tenant bug fixed for tasks earlier in this project), the CRM payload must carry an
   * explicit workspaceId and every DB write is scoped to it, since the same externalCrmId could
   * otherwise collide across two unrelated workspaces' CRM data. The workspaceId alone is NOT
   * trusted (any crm-ninja user can link any workspace id on their side): the workspace must have
   * been explicitly linked to the same crm-ninja account (crm_ninja_tenant_id = tenantId) by one
   * of its admins, otherwise 403.
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
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      // express.raw() only buffers application/json — anything else arrives as {} here.
      res.status(400).json({ error: 'Expected a JSON body' });
      return;
    }
    const rawBody = req.body;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    if ((raw as { event?: unknown } | null)?.event !== 'client.upserted') {
      res.json({ ok: true });
      return;
    }

    const parsed = eventSchema.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const event = parsed.data;

    // Replay protection — the signature covers the timestamp, so an old captured delivery can't
    // be re-dated.
    const sentAt = Date.parse(event.timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_EVENT_AGE_MS) {
      res.status(400).json({ error: 'Stale or invalid timestamp' });
      return;
    }

    const { workspaceId, tenantId, payload } = event;
    const stageParsed = stageSchema.safeParse(payload.stage);
    const stage = stageParsed.success ? stageParsed.data : null;

    (async () => {
      // The workspace must exist AND be linked to this exact crm-ninja account.
      const wsCheck = await pool.query<{ crm_ninja_tenant_id: number | null }>(
        'SELECT crm_ninja_tenant_id FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      const linked = wsCheck.rows[0]?.crm_ninja_tenant_id;
      if (linked == null || Number(linked) !== tenantId) {
        res.status(403).json({ error: 'Workspace is not linked to this CRM account' });
        return;
      }
      await pool.query(
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
          workspaceId, payload.externalCrmId, payload.name, stage,
          payload.mrr ?? null, payload.contactName ?? null, payload.contactEmail ?? null,
        ],
      );
      console.info('[crm-webhook] client.upserted synced', { workspaceId, externalCrmId: payload.externalCrmId });
      res.json({ ok: true });
    })().catch((err: unknown) => {
      console.error('[crm-webhook] DB write failed', err);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  });

  return router;
}
