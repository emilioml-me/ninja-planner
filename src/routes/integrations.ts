import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { fetchAllSummaries, getIntegrationsStatus } from '../integrations/index.js';
import { fetchCrmDeals } from '../integrations/crm.js';
import { upsertActualRevenue } from '../services/revenueService.js';
import type { IntegrationsSummary } from '../integrations/types.js';

const router = Router();

// ─── Server-side cache (5 min TTL per workspace) ─────────────────────────────
// Key: workspaceId. Value: { data, expiresAt }
// This prevents hammering external services on every dashboard load.

interface CacheEntry {
  data: IntegrationsSummary;
  expiresAt: number;
}

const summaryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(workspaceId: string): IntegrationsSummary | null {
  const entry = summaryCache.get(workspaceId);
  if (!entry || entry.expiresAt < Date.now()) {
    summaryCache.delete(workspaceId);
    return null;
  }
  return entry.data;
}

function setCache(workspaceId: string, data: IntegrationsSummary): void {
  summaryCache.set(workspaceId, { data, expiresAt: Date.now() + CACHE_TTL_MS });
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
 * Cached per workspace for 5 minutes.
 *
 * Query param: ?refresh=1 to bypass cache.
 */
router.get('/summary', requireWorkspace, async (req, res, next) => {
  try {
    const workspaceId = req.workspace.id;
    const forceRefresh = req.query.refresh === '1';

    if (!forceRefresh) {
      const cached = getCached(workspaceId);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        res.json(cached);
        return;
      }
    }

    const summary = await fetchAllSummaries();
    setCache(workspaceId, summary);

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
        upsertActualRevenue(req.workspace.id, periodStart, amount),
      ),
    );

    res.json({ synced: byMonth.size, periods: Object.fromEntries(byMonth) });
  } catch (err) {
    next(err);
  }
});

export default router;
