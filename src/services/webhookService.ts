import { createHmac, randomBytes } from 'crypto';
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { isPrivateIp } from '../lib/ssrf.js';
import { trackBackground } from '../lib/background.js';

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
    'SELECT * FROM webhook_endpoints WHERE workspace_id = $1 ORDER BY created_at LIMIT 500',
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
    [workspaceId, data.url, secret, data.events, createdBy],
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

/**
 * Replaces the endpoint's signing secret. Returns the full row (including the new secret, which
 * the caller shows exactly once) or null if the endpoint isn't in this workspace.
 */
export async function rotateEndpointSecret(id: string, workspaceId: string): Promise<WebhookEndpoint | null> {
  const secret = randomBytes(32).toString('hex');
  const result = await pool.query<WebhookEndpoint>(
    'UPDATE webhook_endpoints SET secret = $1 WHERE id = $2 AND workspace_id = $3 RETURNING *',
    [secret, id, workspaceId],
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

// Single source of truth for subscribable event types (webhook-endpoints.ts validates against
// this list; migration 054 backfilled legacy empty-events endpoints to this same set).
export const ALL_EVENTS = [
  'task.created', 'task.updated', 'task.completed', 'task.deleted',
  'review.submitted',
  'epic.created', 'epic.updated', 'epic.deleted',
  'sprint.completed', 'goal.completed',
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
  // Deliberately not awaited by the caller; tracked so graceful shutdown can drain it.
  void trackBackground(_deliver(workspaceId, eventType, payload)).catch((err) => {
    logger.warn({ err, workspaceId, eventType }, 'Webhook delivery batch error');
  });
}

async function _deliver(
  workspaceId: string,
  eventType: WebhookEventType,
  payload: Record<string, unknown>,
): Promise<void> {
  // An empty `events` array is treated as "subscribed to nothing", not a wildcard — see the
  // comment on webhook-endpoints.ts's createSchema for why the previous `events = '{}' OR ...`
  // wildcard semantics were a bug, not a deliberate default.
  const result = await pool.query<WebhookEndpoint>(
    `SELECT * FROM webhook_endpoints
     WHERE workspace_id = $1
       AND active = true
       AND $2 = ANY(events)`,
    [workspaceId, eventType],
  );

  if (result.rows.length === 0) return;

  const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data: payload });

  await Promise.allSettled(
    result.rows.map((endpoint) => _deliverToEndpoint(endpoint, eventType, body, payload)),
  );
}

/**
 * Deliver a one-off event to a specific, already-registered endpoint — used by automation
 * rules' post_webhook action so it gets the same signing/retry/delivery-log pipeline as
 * regular event-subscription webhooks, instead of a bare unsigned, non-retrying fetch to a
 * raw URL typed into the rule. Returns false if the endpoint doesn't exist/isn't active/isn't
 * in this workspace, so the caller can log that distinctly from a delivery failure.
 */
/**
 * Returns 'not_found' if the endpoint doesn't exist/isn't active/isn't in this workspace,
 * 'delivered' if the HTTP call ultimately succeeded, or 'failed' if it was attempted but never
 * got a 2xx after retries. Previously returned a plain boolean that was `true` whenever the
 * endpoint existed, regardless of whether the underlying HTTP delivery actually succeeded — so
 * automation runs against a permanently-failing endpoint were logged as 'ok' with no signal to
 * admins short of cross-referencing the separate webhook_deliveries table.
 */
export async function deliverToEndpoint(
  endpointId: string,
  workspaceId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<'delivered' | 'failed' | 'not_found'> {
  const result = await pool.query<WebhookEndpoint>(
    `SELECT * FROM webhook_endpoints WHERE id = $1 AND workspace_id = $2 AND active = true`,
    [endpointId, workspaceId],
  );
  const endpoint = result.rows[0];
  if (!endpoint) return 'not_found';

  const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), data: payload });
  const delivered = await _deliverToEndpoint(endpoint, eventType, body, payload);
  return delivered ? 'delivered' : 'failed';
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
): Promise<boolean> {
  // Per-endpoint delivery ID so each receiver can correlate retries vs. separate events
  const deliveryId = randomBytes(16).toString('hex');
  let httpStatus: number | null = null;
  let error: string | null = null;
  let status = 'failed';

  let hostname: string | null = null;
  try {
    hostname = new URL(endpoint.url).hostname;
  } catch {
    error = 'Invalid endpoint URL';
  }
  const signature = signPayload(endpoint.secret, body);

  for (let attempt = 0; hostname !== null && attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);

    // DNS-rebinding guard, re-run on EVERY attempt (retries happen up to 70s later, long enough
    // for attacker-controlled DNS with a short TTL to flip to a private address). All resolved
    // addresses must be public. A narrow TOCTOU window between this lookup and fetch()'s own
    // resolution remains; fully closing it would need a pinned-IP dispatcher (undici is not a
    // direct dependency). A failed lookup is transient (retried); a private address is not.
    const hostCheck = await checkResolvedHost(hostname);
    if (hostCheck === 'private') {
      logger.warn({ endpointId: endpoint.id, url: endpoint.url }, 'SSRF: resolved IP is private, aborting delivery');
      httpStatus = null;
      error = 'SSRF: resolved to private IP';
      break;
    }
    if (hostCheck === 'dns_error') {
      httpStatus = null;
      error = 'DNS lookup failed';
      continue;
    }

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
        redirect: 'error',
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

  // Log delivery (best-effort, never throws). Awaited so it's covered by the caller's
  // trackBackground() and isn't dropped on shutdown.
  // delivered_at is only set on success so the health widget shows accurate timestamps.
  await pool.query(
    `INSERT INTO webhook_deliveries (endpoint_id, event_type, payload, status, http_status, error, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [endpoint.id, eventType, payload, status, httpStatus, error, status === 'success' ? new Date() : null],
  ).catch(() => {});

  return status === 'success';
}

/**
 * Resolve the endpoint host and classify it: 'ok' (every address public), 'private' (any address
 * private/internal - SSRF, never retried) or 'dns_error' (lookup failed / no records - transient,
 * retried like a network error).
 */
async function checkResolvedHost(hostname: string): Promise<'ok' | 'private' | 'dns_error'> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return isPrivateIp(host) ? 'private' : 'ok';
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return 'dns_error';
    return addresses.every(({ address }) => !isPrivateIp(address)) ? 'ok' : 'private';
  } catch {
    return 'dns_error';
  }
}
