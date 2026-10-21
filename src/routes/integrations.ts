import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin, ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { fetchAllSummaries, getIntegrationsStatus } from '../integrations/index.js';
import { getServiceConfig } from '../integrations/client.js';
import { fetchCrmDeals, fetchCrmClients, verifyCrmTenantLink } from '../integrations/crm.js';
import { fetchPaymentsSummary } from '../integrations/payments.js';
import { getNinjaTaskProfile } from '../integrations/ninjatask.js';
import { upsertActualRevenue, resetStaleSyncedRevenue } from '../services/revenueService.js';
import { pool } from '../config/db.js';
import { isOperatorWorkspace } from '../lib/operator.js';
import type { IntegrationsSummary } from '../integrations/types.js';

const router = Router();

/** crm-ninja's /api/internal/deals page size (it returns at most this many, newest first). */
const CRM_DEALS_PAGE_MAX = 500;

async function getCrmTenantId(workspaceId: string): Promise<number | null> {
  const result = await pool.query<{ crm_ninja_tenant_id: number | null }>(
    'SELECT crm_ninja_tenant_id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return result.rows[0]?.crm_ninja_tenant_id ?? null;
}

// ─── Server-side cache (5 min TTL, per workspace) ────────────────────────────
// CRM data is now workspace-specific (each workspace can link to a different crm-ninja tenant —
// see crm-tenant routes below), so the summary as a whole must be cached per workspace even
// though payments/helpdesk/schedule/ninjatask are still shared deployment-wide env-var-backed
// integrations underneath (payments/helpdesk/schedule are only fetched for operator workspaces —
// see fetchAllSummaries).

interface CacheEntry {
  data: IntegrationsSummary;
  expiresAt: number;
}

const summaryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Keys are per workspace+user, so without a bound the Map grows with every user who ever opens
// the dashboard. Expired entries are swept on write; beyond the cap the oldest entry (Map keeps
// insertion order) is evicted.
const CACHE_MAX_ENTRIES = 1000;

function getCached(cacheKey: string): IntegrationsSummary | null {
  const entry = summaryCache.get(cacheKey);
  if (!entry || entry.expiresAt < Date.now()) {
    summaryCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCache(cacheKey: string, data: IntegrationsSummary): void {
  const now = Date.now();
  for (const [key, entry] of summaryCache) {
    if (entry.expiresAt < now) summaryCache.delete(key);
  }
  summaryCache.delete(cacheKey); // re-insert at the end (most recent)
  while (summaryCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = summaryCache.keys().next().value;
    if (oldest === undefined) break;
    summaryCache.delete(oldest);
  }
  summaryCache.set(cacheKey, { data, expiresAt: now + CACHE_TTL_MS });
}

/** Invalidates every cached summary for a workspace (all users) — cache keys are `${workspaceId}:${clerkId}`. */
function invalidateWorkspaceCache(workspaceId: string): void {
  for (const key of summaryCache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) summaryCache.delete(key);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/integrations/status
 * Returns which integrations are configured (no external calls, no secrets exposed).
 */
router.get('/status', requireWorkspace, (req, res) => {
  res.json(getIntegrationsStatus(req.workspace.id));
});

/** Same gate the payments sync route uses (operator workspace + payment-ninja configured). */
function paymentsSyncAvailable(workspaceId: string): boolean {
  return isOperatorWorkspace(workspaceId) && !!getServiceConfig('PAYMENT_NINJA');
}

/**
 * GET /api/integrations/capabilities
 * Which integration-backed actions actually do something for this workspace, so the UI can hide
 * controls that would no-op (Slack alert) or 503 (payments sync). No external calls.
 */
router.get('/capabilities', requireWorkspace, async (req, res, next) => {
  try {
    const operator = isOperatorWorkspace(req.workspace.id);
    const crmTenantId = await getCrmTenantId(req.workspace.id);
    res.json({
      slack_alerts:  operator && !!process.env.SLACK_WEBHOOK_URL,
      payments_sync: paymentsSyncAvailable(req.workspace.id),
      crm_linked:    crmTenantId !== null && !!getServiceConfig('CRM_NINJA'),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/integrations/summary
 * Returns live data from all configured integrations. Cached per workspace+user for 5 minutes.
 *
 * Query param: ?refresh=1 to bypass cache (admins only; ignored for other roles).
 */
router.get('/summary', requireWorkspace, async (req, res, next) => {
  try {
    const workspaceId = req.workspace.id;
    // Only admins may bypass the cache - every refresh fans out to all upstream services.
    // Non-admin refresh requests silently fall back to the cached copy.
    const isAdmin = !!req.auth.memberRole && ADMIN_ROLES.has(req.auth.memberRole);
    const forceRefresh = req.query.refresh === '1' && isAdmin;
    // Cache key includes the requesting user, not just the workspace — the ninja-task slot is
    // now per-user (see fetchAllSummaries), so a workspace-only key would leak the first
    // requester's ninja-task profile to every other member for the rest of the TTL window.
    const cacheKey = `${workspaceId}:${req.auth.userId}`;

    if (!forceRefresh) {
      const cached = getCached(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        return;
      }
    }

    const crmTenantId = await getCrmTenantId(workspaceId);
    const summary = await fetchAllSummaries(workspaceId, crmTenantId, req.auth.userId);
    setCache(cacheKey, summary);

    res.setHeader('X-Cache', 'MISS');
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/integrations/crm-tenant  [admin only]
 * Returns the crm-ninja user id this workspace is linked to, or null if unlinked.
 */
router.get('/crm-tenant', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const tenantId = await getCrmTenantId(req.workspace.id);
    res.json({ tenantId });
  } catch (err) {
    next(err);
  }
});

// `code` is required whenever tenantId is being set (non-null) — proves the caller actually
// controls that crm-ninja account, closing the IDOR where any guessed integer tenant id used
// to be accepted with no verification. Not required to unlink (tenantId: null).
const crmTenantSchema = z.object({ tenantId: z.number().int().positive().nullable(), code: z.string().min(1).max(64).optional() })
  .refine((d) => d.tenantId === null || !!d.code, { message: 'code is required to link a CRM tenant', path: ['code'] });

/**
 * PATCH /api/integrations/crm-tenant  [admin only]
 * Links (or unlinks, with tenantId: null) this workspace to a crm-ninja user account.
 * crm-ninja has no multi-tenant concept of its own — its API scopes every query by a single
 * user id sent as X-Tenant-ID, so this mapping is what lets ninja-planner's CRM sync/summary
 * pull the right account's data for this workspace instead of a shared, unscoped default.
 *
 * Linking requires a one-time `code` the crm-ninja user generates themselves (via
 * POST /api/integrations/ninja-planner/link-code on crm-ninja) — verified server-to-server via
 * verifyCrmTenantLink before the mapping is persisted. Without this, any workspace admin could
 * link to any guessed tenant id and pull an unrelated account's CRM data.
 */
router.patch('/crm-tenant', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const parsed = crmTenantSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    if (parsed.data.tenantId !== null) {
      const verified = await verifyCrmTenantLink(parsed.data.tenantId, parsed.data.code!);
      if (!verified) {
        res.status(403).json({ error: 'Invalid or expired linking code. Generate a new one from crm-ninja and try again.' });
        return;
      }
    }

    await pool.query(
      'UPDATE workspaces SET crm_ninja_tenant_id = $1 WHERE id = $2',
      [parsed.data.tenantId, req.workspace.id],
    );
    invalidateWorkspaceCache(req.workspace.id);
    res.json({ tenantId: parsed.data.tenantId });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/sync-revenue
 * Pulls closed_won deals from this workspace's linked crm-ninja tenant and upserts
 * actual_amount per month. Returns a summary of what was synced.
 *
 * Requires the workspace to be linked to a crm-ninja user account first — see
 * PATCH /api/integrations/crm-tenant. crm-ninja has no multi-tenant concept of its own, so
 * without an explicit per-workspace mapping there is no way to know whose CRM data to pull.
 */
router.post('/sync-revenue', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const crmTenantId = await getCrmTenantId(req.workspace.id);
    if (crmTenantId === null) {
      res.status(400).json({ error: 'This workspace is not linked to a CRM tenant. Set one via PATCH /api/integrations/crm-tenant first.' });
      return;
    }

    // Captured before the fetch so it reflects how fresh this sync's CRM data is — used to
    // order concurrent/retried syncs regardless of which one's DB write actually lands last.
    const syncedAt = new Date();
    const result = await fetchCrmDeals(crmTenantId, 'closed_won');
    if (!result.configured) {
      res.status(503).json({ error: 'CRM integration is not configured' });
      return;
    }
    if (!result.data) {
      res.status(502).json({ error: result.error ?? 'CRM fetch failed' });
      return;
    }

    const deals = (Array.isArray(result.data.deals) ? result.data.deals : [])
      .map((deal) => {
        const month = typeof deal?.closed_at === 'string' && /^\d{4}-\d{2}/.test(deal.closed_at)
          ? deal.closed_at.slice(0, 7) + '-01' // YYYY-MM-01
          : null;
        const value = typeof deal?.value === 'number' ? deal.value : Number(deal?.value);
        const currency = typeof deal?.currency === 'string' && deal.currency.trim()
          ? deal.currency.trim().toUpperCase()
          : null;
        return { month, value, currency };
      })
      .filter((d): d is { month: string; value: number; currency: string | null } =>
        d.month !== null && Number.isFinite(d.value));

    // crm-ninja returns at most CRM_DEALS_PAGE_MAX deals, newest first. A full page means older
    // deals were cut off, so the oldest month present is (probably) only partially covered:
    // don't write it, and treat only the months after it as "covered" by this sync.
    const truncated = (result.data.deals?.length ?? 0) >= CRM_DEALS_PAGE_MAX;
    const oldestMonth = deals.reduce<string | null>((min, d) => (min === null || d.month < min ? d.month : min), null);
    const partialMonth = truncated ? oldestMonth : null;

    // revenue_targets has no currency column, so amounts in different currencies can't be summed.
    // Use the workspace's dominant deal currency (most deals; deals without a currency are assumed
    // to be in it) and ignore the rest, reporting how many were left out.
    const currencyCounts = new Map<string, number>();
    for (const d of deals) {
      if (d.currency) currencyCounts.set(d.currency, (currencyCounts.get(d.currency) ?? 0) + 1);
    }
    const currency = [...currencyCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

    // Group deal values by first-of-month
    const byMonth = new Map<string, number>();
    let ignoredDeals = 0;
    for (const d of deals) {
      if (d.month === partialMonth) continue;
      if (currency !== null && d.currency !== null && d.currency !== currency) { ignoredDeals++; continue; }
      byMonth.set(d.month, Math.round(((byMonth.get(d.month) ?? 0) + d.value) * 100) / 100);
    }

    // Upsert each month. Months already owned by another source (payments, or a manual edit) are
    // skipped, not overwritten - see upsertActualRevenue's source rule.
    const entries = Array.from(byMonth.entries());
    const written = await Promise.all(
      entries.map(([periodStart, amount]) =>
        upsertActualRevenue(req.workspace.id, periodStart, amount, syncedAt, 'crm'),
      ),
    );
    const skipped = entries.filter((_, i) => !written[i]).map(([periodStart]) => periodStart);

    // Months this sync previously filled from CRM that no longer have any won deals inside the
    // covered window (deal un-won / deleted upstream) are reset to 0 instead of keeping a stale
    // figure forever.
    const reset = await resetStaleSyncedRevenue(
      req.workspace.id, 'crm', entries.map(([periodStart]) => periodStart), partialMonth, syncedAt,
    );

    res.json({
      synced: byMonth.size - skipped.length,
      skipped,
      reset,
      partial_month_dropped: partialMonth,
      currency,
      ignored_deals: ignoredDeals,
      periods: Object.fromEntries(byMonth),
    });
  } catch (err) {
    next(err);
  }
});

const CLIENT_STAGES = new Set(['prospect', 'proposal', 'active', 'churned']);
const emailSchema = z.string().email().max(255);
const SYNC_CLIENTS_CHUNK = 500;

interface SyncClientRow {
  externalId: string;
  name: string;
  contactName: string | null;
  hasContactName: boolean;
  email: string | null;
  hasEmail: boolean;
  stage: string | null;
  mrr: number | null;
}

/**
 * POST /api/integrations/sync-clients
 * Bulk-pulls this workspace's linked crm-ninja tenant's full contact roster and upserts it into
 * the local `clients` table, matched by (workspace_id, external_crm_id) — see migration 046.
 * Complements the real-time client.upserted webhook (routes/crmWebhook.ts): this is the
 * on-demand/periodic reconciliation pass (e.g. initial backfill, or catching up after the
 * webhook was down), not a replacement for it.
 *
 * Runs in one transaction (all-or-nothing), as chunked set-based statements. Missing/unrecognised
 * values never clobber local data: an unknown stage keeps the existing stage (new rows default to
 * 'prospect'), a missing or malformed email/contact_name keeps the existing value (an explicit
 * null or '' clears it), and a missing mrr keeps the existing mrr. Rows without a usable id/name
 * are skipped and counted.
 *
 * CRM-linked clients deleted locally are tombstoned (crm_client_tombstones, migration 067) and
 * never re-created; they're reported as ignored_deleted.
 */
router.post('/sync-clients', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const crmTenantId = await getCrmTenantId(req.workspace.id);
    if (crmTenantId === null) {
      res.status(400).json({ error: 'This workspace is not linked to a CRM tenant. Set one via PATCH /api/integrations/crm-tenant first.' });
      return;
    }

    const result = await fetchCrmClients(crmTenantId);
    if (!result.configured) {
      res.status(503).json({ error: 'CRM integration is not configured' });
      return;
    }
    if (!result.data || !Array.isArray(result.data.clients)) {
      res.status(502).json({ error: result.error ?? 'CRM fetch failed' });
      return;
    }

    let skipped = 0;
    // Deduped by external id (last wins) so one batch never touches the same row twice.
    const rows = new Map<string, SyncClientRow>();
    for (const client of result.data.clients) {
      const externalId = client?.id != null ? String(client.id).slice(0, 255) : '';
      const name = typeof client?.name === 'string' ? client.name.trim().slice(0, 255) : '';
      if (!externalId || !name) { skipped++; continue; }
      const stage = typeof client.stage === 'string' && CLIENT_STAGES.has(client.stage) ? client.stage : null;
      // Contact fields: absent or malformed = keep the local value; explicit null/'' = clear it.
      let email: string | null = null;
      let hasEmail = false;
      if (client.email === null || (typeof client.email === 'string' && client.email.trim() === '')) {
        hasEmail = true;
      } else if (typeof client.email === 'string' && emailSchema.safeParse(client.email.trim()).success) {
        hasEmail = true;
        email = client.email.trim();
      }
      let contactName: string | null = null;
      let hasContactName = false;
      if (client.contact_name === null) {
        hasContactName = true;
      } else if (typeof client.contact_name === 'string') {
        hasContactName = true;
        contactName = client.contact_name.trim().slice(0, 255) || null;
      }
      const mrrNum = typeof client.mrr === 'number' ? client.mrr : Number(client.mrr);
      const mrr = client.mrr != null && Number.isFinite(mrrNum) && mrrNum >= 0 && mrrNum < 1e10 ? mrrNum : null;
      rows.set(externalId, { externalId, name, contactName, hasContactName, email, hasEmail, stage, mrr });
    }

    // Clients deleted locally are tombstoned (clientService.deleteClient) - never re-create them.
    const tombstones = await pool.query<{ external_crm_id: string }>(
      'SELECT external_crm_id FROM crm_client_tombstones WHERE workspace_id = $1 AND external_crm_id = ANY($2::text[])',
      [req.workspace.id, [...rows.keys()]],
    );
    for (const t of tombstones.rows) rows.delete(t.external_crm_id);
    const ignoredDeleted = tombstones.rows.length;

    const allRows = [...rows.values()];
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      // Set-based upsert in chunks (two statements per chunk) instead of one round-trip per client.
      for (let i = 0; i < allRows.length; i += SYNC_CLIENTS_CHUNK) {
        const chunk = allRows.slice(i, i + SYNC_CLIENTS_CHUNK);
        const params = [
          req.workspace.id,
          chunk.map((r) => r.externalId),
          chunk.map((r) => r.name),
          chunk.map((r) => r.contactName),
          chunk.map((r) => r.hasContactName),
          chunk.map((r) => r.email),
          chunk.map((r) => r.hasEmail),
          chunk.map((r) => r.stage),
          chunk.map((r) => r.mrr),
        ];
        const source = `unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[], $7::boolean[], $8::text[], $9::numeric[])
                          AS t(ext, name, contact_name, has_contact_name, email, has_email, stage, mrr)`;
        await db.query(
          `UPDATE clients c SET
             name          = t.name,
             contact_name  = CASE WHEN t.has_contact_name THEN t.contact_name ELSE c.contact_name END,
             contact_email = CASE WHEN t.has_email THEN t.email ELSE c.contact_email END,
             stage         = COALESCE(t.stage, c.stage),
             mrr           = COALESCE(t.mrr, c.mrr),
             updated_at    = now()
           FROM ${source}
           WHERE c.workspace_id = $1 AND c.external_crm_id = t.ext`,
          params,
        );
        await db.query(
          `INSERT INTO clients (workspace_id, external_crm_id, name, contact_name, contact_email, stage, mrr)
           SELECT $1, t.ext, t.name, t.contact_name, t.email, COALESCE(t.stage, 'prospect'), COALESCE(t.mrr, 0)
           FROM ${source}
           WHERE NOT EXISTS (
             SELECT 1 FROM crm_client_tombstones ct WHERE ct.workspace_id = $1 AND ct.external_crm_id = t.ext
           )
           ON CONFLICT (workspace_id, external_crm_id) WHERE external_crm_id IS NOT NULL DO NOTHING`,
          params,
        );
      }
      await db.query('COMMIT');
    } catch (txErr) {
      await db.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      db.release();
    }

    res.json({ synced: allRows.length, skipped, ignored_deleted: ignoredDeleted });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/sync-revenue-payments
 * Pulls current-month revenue from payment-ninja and upserts it as actual_amount for the
 * current month. Unlike CRM sync (itemized deals grouped by close date across many months),
 * payment-ninja's summary only exposes an aggregate current/last-month total — this endpoint
 * syncs whichever of those two periods have already passed or are in progress.
 */
router.post('/sync-revenue-payments', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    // payment-ninja is wired to one global, un-scoped key — its figures are the operator's own
    // revenue and must never be written into a customer workspace (C5).
    if (!isOperatorWorkspace(req.workspace.id)) {
      res.status(503).json({ error: 'Payments integration is not available for this workspace' });
      return;
    }
    const syncedAt = new Date();
    const result = await fetchPaymentsSummary();
    if (!result.configured) {
      res.status(503).json({ error: 'Payments integration is not configured' });
      return;
    }
    if (!result.data) {
      res.status(502).json({ error: result.error ?? 'Payments fetch failed' });
      return;
    }

    const now = new Date();
    const currentPeriodStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const lastPeriodStart = `${lastMonthDate.getUTCFullYear()}-${String(lastMonthDate.getUTCMonth() + 1).padStart(2, '0')}-01`;

    const [curWritten, lastWritten] = await Promise.all([
      upsertActualRevenue(req.workspace.id, currentPeriodStart, result.data.currentMonthRevenue, syncedAt, 'payments'),
      upsertActualRevenue(req.workspace.id, lastPeriodStart, result.data.lastMonthRevenue, syncedAt, 'payments'),
    ]);
    // Months already owned by the CRM sync are left untouched (see upsertActualRevenue).
    const skipped = [
      ...(curWritten ? [] : [currentPeriodStart]),
      ...(lastWritten ? [] : [lastPeriodStart]),
    ];

    res.json({
      synced: 2 - skipped.length,
      skipped,
      periods: {
        [currentPeriodStart]: result.data.currentMonthRevenue,
        [lastPeriodStart]: result.data.lastMonthRevenue,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/integrations/ninja-task/profile?clerkId=...
 * Browser-facing proxy: fetches a user's XP/level from ninja-task.
 * Returns null (not an error) if the integration is not configured or the call fails.
 */
router.get('/ninja-task/profile', requireWorkspace, async (req, res, next) => {
  try {
    const clerkId = req.query.clerkId as string | undefined;
    if (!clerkId) {
      res.status(400).json({ error: 'clerkId query param required' });
      return;
    }
    // Cross-tenant guard: only allow querying members of the caller's own workspace
    const memberCheck = await pool.query(
      'SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [req.workspace.id, clerkId],
    );
    if (memberCheck.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }
    const result = await getNinjaTaskProfile(clerkId);
    // Graceful degradation: always return 200; caller checks for null
    res.json(result ?? null);
  } catch (err) {
    next(err);
  }
});

export default router;
