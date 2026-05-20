import { createHmac, randomBytes } from 'crypto';
import { lookup } from 'dns/promises';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';

// Mirrors the SSRF check in webhook-endpoints.ts — applied at delivery time to catch DNS rebinding.
const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1$|fd[0-9a-f]{2}:|0\.0\.0\.0)$/i;

async function resolvedIpIsSafe(hostname: string): Promise<boolean> {
  try {
    const { address } = await lookup(hostname);
    return !PRIVATE_IP_RE.test(address);
  } catch {
    return false; // DNS failure or invalid hostname — treat as unsafe
  }
}

export interface WebhookEndpoint {
  id: string;
  workspace_id: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  created_by: string;
  created_at: Date;
}

export interface WebhookDelivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: string;
  http_status: number | null;
  error: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function getEndpoints(workspaceId: string): Promise<WebhookEndpoint[]> {
  const result = await pool.query<WebhookEndpoint>(
    'SELECT * FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at',
    [workspaceId],
  );
  return result.rows;
}

export async function createEndpoint(
  workspaceId: string,
  data: { url: string; events: string[] },
  createdBy: string,
): Promise<WebhookEndpoint> {
  const secret = randomBytes(32).toString('hex');
  const result = await pool.query<WebhookEndpoint>(
    `INSERT INTO webhook_endpoints (workspace_id, url, secret, events, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workspaceId, data.url, secret, data.events],
  );
  return result.rows[0];
}

export async function updateEndpoint(
  id: string,
  workspaceId: string,
  data: { url?: string; events?: string[]; active?: boolean },
): Promise<WebhookEndpoint | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (data.url     !== undefined) { fields.push(`url = $${i++}`);     values.push(data.url); }
  if (data.events  !== undefined) { fields.push(`events = $${i++}`);  values.push(data.events); }
  if (data.active  !== undefined) { fields.push(`active = $${i++}`);  values.push(data.active); }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<WebhookEndpoint>(
    `UPDATE webhook_endpoints SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export async function deleteEndpoint(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getDeliveries(endpointId: string, workspaceId: string): Promise<WebhookDelivery[]> {
  // Verify ownership via JOIN
  const result = await pool.query<WebhookDelivery>(
    `SELECT wd.* FROM webhook_deliveries wd
     JOIN webhook_endpoints we ON we.id = wd.endpoint_id
     WHERE wd.endpoint_id = $1 AND we.workspace_id = $2
     ORDER BY wd.created_at DESC
     LIMIT 50`,
    [endpointId, workspaceId],
  );
  return result.rows;
}

// ─── Delivery ─────────────────────────────────────────────────────────────────

const ALL_EVENTS = [
  'task.created', 'task.updated', 'task.completed', 'task.deleted',
  'review.submitted',
] as const;

export type WebhookEventType = typeof ALL_EVENTS[number];

function signPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Fire webhooks for all active endpoints in the workspace that subscribe to this event.
 * Runs fire-and-forget — never blocks the caller, never throws.
 */
export function fireWebhooks(
  workspaceId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): void {
  // Deliberately not awaited
  _deliver(workspaceId, eventType, payload).catch((err) => {
    logger.warn({ err, workspaceId, eventType }, 'Webhook delivery batch error');
  });
}

async function _deliver(
  workspaceId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  const result = await pool.query<WebhookEndpoint>(
    `SELECT * FROM webhook_endpoints
     WHERE workspace_id = $1
       AND active = true
       AND (events = '{}' OR $2 = ANY(events))`,
    [workspaceId, eventType],
  );

  if (result.rows.length === 0) return;

  const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data: payload });

  await Promise.allSettled(
    result.rows.map((endpoint) => _deliverToEndpoint(endpoint, eventType, body, payload)),
  );
}

/** Retry delays: immediate → 10 s → 60 s */
const RETRY_DELAYS_MS = [0, 10_000, 60_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function _deliverToEndpoint(
  endpoint: WebhookEndpoint,
  eventType: string,
  body: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Per-endpoint delivery ID so each receiver can correlate retries vs. separate events
  const deliveryId = randomBytes(16).toString('hex');
  // DNS-rebinding guard: verify the resolved IP is still public at delivery time
  const { hostname } = new URL(endpoint.url);
  if (!(await resolvedIpIsSafe(hostname))) {
    logger.warn({ endpointId: endpoint.id, url: endpoint.url }, 'SSRF: resolved IP is private, aborting delivery');
    pool.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, http_status, error, delivered_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [endpoint.id, eventType, payload, 'failed', null, 'SSRF: resolved to private IP', null],
    ).catch(() => {});
    return;
  }

  const signature = signPayload(endpoint.secret, body);
  let httpStatus: number | null = null;
  let error: string | null = null;
  let status = 'failed';

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ninja-Event': eventType,
          'X-Ninja-Signature': signature,
          'X-Ninja-Delivery': deliveryId,
          'X-Ninja-Retry': String(attempt),
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      httpStatus = res.status;
      if (res.ok) {
        status = 'success';
        error = null;
        break; // ✓ delivered
      }
      error = `HTTP ${res.status}`;
      if (res.status < 500) break; // 4xx — receiver issue, don't retry
      // 5xx — try again
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Network / timeout error — will retry if attempts remain
    }
  }

  if (status !== 'success') {
    logger.warn(
      { endpointId: endpoint.id, url: endpoint.url, eventType, error, attempts: RETRY_DELAYS_MS.length },
      'Webhook delivery failed after retries',
    );
  }

  // Log delivery (best-effort, don't block or throw)
  // delivered_at is only set on success so the health widget shows accurate timestamps.
  pool.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, http_status, error, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint.id, eventType, payload, status, httpStatus, error, status === 'success' ? new Date() : null],
  ).catch(() => {});
}
