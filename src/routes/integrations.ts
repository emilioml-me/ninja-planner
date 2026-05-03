import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { fetchAllSummaries, getIntegrationsStatus } from '../integrations/index.js';
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

export default router;
