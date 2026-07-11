import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { fetchAllSummaries, getIntegrationsStatus } from '../integrations/index.js';
import { fetchCrmDeals } from '../integrations/crm.js';
import { fetchPaymentsSummary } from '../integrations/payments.js';
import { getNinjaTaskProfile } from '../integrations/ninjatask.js';
import { upsertActualRevenue } from '../services/revenueService.js';
import { pool } from '../config/db.js';
import type { IntegrationsSummary } from '../integrations/types.js';

const router = Router();

// ─── Server-side cache (5 min TTL, global key) ───────────────────────────────
// Integration credentials are global env vars (one set for the whole deployment),
// so all workspaces share the same external data. Using a single cache key means
// one fetch serves every workspace within the TTL window.

interface CacheEntry {
  data: IntegrationsSummary;
  expiresAt: number;
}

const summaryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const GLOBAL_CACHE_KEY = '__global__';

function getCached(): IntegrationsSummary | null {
  const entry = summaryCache.get(GLOBAL_CACHE_KEY);
  if (!entry || entry.expiresAt < Date.now()) {
    summaryCache.delete(GLOBAL_CACHE_KEY);
    return null;
  }
  return entry.data;
}

function setCache(data: IntegrationsSummary): void {
  summaryCache.set(GLOBAL_CACHE_KEY, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/integrations/status
 * Returns which integrations are configured (no external calls, no secrets exposed).
 */
router.get('/status', requireWorkspace, (_req, res) => {
  res.json(getIntegrationsStatus());
});

/**
 * GET /api/integrations/summary
 * Returns live data from all configured integrations.
 * Cached globally for 5 minutes (not per workspace) — see the cache section above: credentials
 * are shared deployment-wide env vars, so every workspace's request hits the same cache entry.
 *
 * Query param: ?refresh=1 to bypass cache.
 */
router.get('/summary', requireWorkspace, async (req, res, next) => {
  try {
    const workspaceId = req.workspace.id;
    const forceRefresh = req.query.refresh === '1';

    if (!forceRefresh) {
      const cached = getCached();
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        return;
      }
    }

    const summary = await fetchAllSummaries();
    setCache(summary);

    res.setHeader('X-Cache', 'MISS');
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/sync-revenue
 * Pulls closed_won deals from crm-ninja and upserts actual_amount per month.
 * Returns a summary of what was synced.
 */
router.post('/sync-revenue', requireWorkspace, async (req, res, next) => {
  try {
    // Captured before the fetch so it reflects how fresh this sync's CRM data is — used to
    // order concurrent/retried syncs regardless of which one's DB write actually lands last.
    const syncedAt = new Date();
    const result = await fetchCrmDeals('closed_won');
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

    // Upsert each month
    await Promise.all(
      Array.from(byMonth.entries()).map(([periodStart, amount]) =>
        upsertActualRevenue(req.workspace.id, periodStart, amount, syncedAt),
      ),
    );

    res.json({ synced: byMonth.size, periods: Object.fromEntries(byMonth) });
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
router.post('/sync-revenue-payments', requireWorkspace, async (req, res, next) => {
  try {
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

    await Promise.all([
      upsertActualRevenue(req.workspace.id, currentPeriodStart, result.data.currentMonthRevenue, syncedAt),
      upsertActualRevenue(req.workspace.id, lastPeriodStart, result.data.lastMonthRevenue, syncedAt),
    ]);

    res.json({
      synced: 2,
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
