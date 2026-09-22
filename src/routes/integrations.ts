import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { fetchAllSummaries, getIntegrationsStatus } from '../integrations/index.js';
import { fetchCrmDeals, fetchCrmClients, verifyCrmTenantLink } from '../integrations/crm.js';
import { fetchPaymentsSummary } from '../integrations/payments.js';
import { getNinjaTaskProfile } from '../integrations/ninjatask.js';
import { upsertActualRevenue } from '../services/revenueService.js';
import { pool } from '../config/db.js';
import { isOperatorWorkspace } from '../lib/operator.js';
import type { IntegrationsSummary } from '../integrations/types.js';

const router = Router();

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

/**
 * GET /api/integrations/summary
 * Returns live data from all configured integrations. Cached per workspace+user for 5 minutes.
 *
 * Query param: ?refresh=1 to bypass cache.
 */
router.get('/summary', requireWorkspace, async (req, res, next) => {
  try {
    const workspaceId = req.workspace.id;
    const forceRefresh = req.query.refresh === '1';
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

    // Group deal values by first-of-month
    const byMonth = new Map<string, number>();
    for (const deal of result.data.deals) {
      if (!deal.closed_at) continue;
      const periodStart = deal.closed_at.slice(0, 7) + '-01'; // YYYY-MM-01
      byMonth.set(periodStart, (byMonth.get(periodStart) ?? 0) + deal.value);
    }

    // Upsert each month. Months already owned by the payments sync are skipped, not overwritten —
    // see upsertActualRevenue's source rule.
    const entries = Array.from(byMonth.entries());
    const written = await Promise.all(
      entries.map(([periodStart, amount]) =>
        upsertActualRevenue(req.workspace.id, periodStart, amount, syncedAt, 'crm'),
      ),
    );
    const skipped = entries.filter((_, i) => !written[i]).map(([periodStart]) => periodStart);

    res.json({ synced: byMonth.size - skipped.length, skipped, periods: Object.fromEntries(byMonth) });
  } catch (err) {
    next(err);
  }
});

const CLIENT_STAGES = new Set(['prospect', 'proposal', 'active', 'churned']);
const emailSchema = z.string().email().max(255);

/**
 * POST /api/integrations/sync-clients
 * Bulk-pulls this workspace's linked crm-ninja tenant's full contact roster and upserts it into
 * the local `clients` table, matched by (workspace_id, external_crm_id) — see migration 046.
 * Complements the real-time client.upserted webhook (routes/crmWebhook.ts): this is the
 * on-demand/periodic reconciliation pass (e.g. initial backfill, or catching up after the
 * webhook was down), not a replacement for it.
 *
 * Runs in one transaction (all-or-nothing). Missing/unrecognised values never clobber local data:
 * an unknown stage keeps the existing stage (new rows default to 'prospect'), a missing or
 * malformed email keeps the existing contact_email, and a missing mrr keeps the existing mrr.
 * Rows without a usable id/name are skipped and counted.
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

    let synced = 0;
    let skipped = 0;
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const client of result.data.clients) {
        const externalId = client?.id != null ? String(client.id).slice(0, 255) : '';
        const name = typeof client?.name === 'string' ? client.name.trim().slice(0, 255) : '';
        if (!externalId || !name) { skipped++; continue; }
        const stage = typeof client.stage === 'string' && CLIENT_STAGES.has(client.stage) ? client.stage : null;
        const email = emailSchema.safeParse(client.email).success ? (client.email as string) : null;
        const mrrNum = typeof client.mrr === 'number' ? client.mrr : Number(client.mrr);
        const mrr = client.mrr != null && Number.isFinite(mrrNum) && mrrNum >= 0 && mrrNum < 1e10 ? mrrNum : null;
        await db.query(
          `INSERT INTO clients (workspace_id, external_crm_id, name, contact_email, stage, mrr)
           VALUES ($1, $2, $3, $4, COALESCE($5, 'prospect'), COALESCE($6, 0))
           ON CONFLICT (workspace_id, external_crm_id) WHERE external_crm_id IS NOT NULL DO UPDATE SET
             name          = EXCLUDED.name,
             contact_email = COALESCE($4, clients.contact_email),
             stage         = COALESCE($5, clients.stage),
             mrr           = COALESCE($6, clients.mrr),
             updated_at    = now()`,
          [req.workspace.id, externalId, name, email, stage, mrr],
        );
        synced++;
      }
      await db.query('COMMIT');
    } catch (txErr) {
      await db.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      db.release();
    }

    res.json({ synced, skipped });
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
