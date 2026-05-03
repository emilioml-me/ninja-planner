import { createHmac, randomBytes } from 'crypto';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';

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
  const deliveryId = randomBytes(16).toString('hex');

  await Promise.allSettled(
    result.rows.map((endpoint) => _deliverToEndpoint(endpoint, eventType, body, deliveryId, payload)),
  );
}

async function _deliverToEndpoint(
  endpoint: WebhookEndpoint,
  eventType: string,
  body: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const signature = signPayload(endpoint.secret, body);
  let httpStatus: number | null = null;
  let error: string | null = null;
  let status = 'failed';

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ninja-Event': eventType,
        'X-Ninja-Signature': signature,
        'X-Ninja-Delivery': deliveryId,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    httpStatus = res.status;
    status = res.ok ? 'success' : 'failed';
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.warn({ endpointId: endpoint.id, url: endpoint.url, eventType, error }, 'Webhook delivery failed');
  }

  // Log delivery (best-effort, don't block or throw)
  pool.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, http_status, error, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint.id, eventType, payload, status, httpStatus, error, new Date()],
  ).catch(() => {});
}
