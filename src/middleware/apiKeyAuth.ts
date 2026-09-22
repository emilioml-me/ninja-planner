// API key auth middleware — for /api/external/* routes consumed by third-party integrations
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Dedicated brute-force guard (per IP) — the global app-wide limiter (200/min) is far too
// permissive for guessing a fixed-format secret key. Only FAILED attempts count
// (skipSuccessfulRequests), so a legitimate integration making many valid calls is never locked
// out by this limiter; normal throughput is bounded by the per-key limiter below instead.
export const apiKeyAuthLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
});

// Generous per-key throughput limiter, keyed by the authenticated key's id (applied inside
// apiKeyAuth after the key is resolved, so external routes need no extra wiring).
const perKeyLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `apikey:${req.apiKey?.id ?? 'unknown'}`,
  message: { error: 'API key rate limit exceeded, please slow down' },
});

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: {
      id: string;
      workspace_id: string;
      scopes: string[];
    };
  }
}

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers['authorization'] ?? '';
  const key    = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!key) { res.status(401).json({ error: 'API key required' }); return; }

  const hash = hashKey(key);

  // DB failures must surface as 503, not as "invalid key" — reporting a valid key as revoked
  // during an outage sends integrators chasing the wrong problem (and burns brute-force budget).
  let keyRow: { id: string; workspace_id: string; scopes: string[] } | undefined;
  let ws: { id: string; name: string; plan: string } | undefined;
  try {
    const { rows } = await pool.query<{ id: string; workspace_id: string; scopes: string[] }>(
      `SELECT id, workspace_id, scopes FROM api_keys
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
    keyRow = rows[0];
    if (keyRow) {
      const wsRes = await pool.query<{ id: string; name: string; plan: string }>(
        'SELECT id, name, plan FROM workspaces WHERE id = $1',
        [keyRow.workspace_id],
      );
      ws = wsRes.rows[0];
    }
  } catch (err) {
    logger.error({ err }, 'API key lookup failed');
    res.status(503).json({ error: 'Service temporarily unavailable' });
    return;
  }

  if (!keyRow) { res.status(401).json({ error: 'Invalid or revoked API key' }); return; }
  if (!ws) { res.status(401).json({ error: 'Workspace not found' }); return; }

  // Fire-and-forget usage timestamp update
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyRow.id]).catch(() => {});

  req.apiKey   = { id: keyRow.id, workspace_id: keyRow.workspace_id, scopes: keyRow.scopes };
  req.workspace = ws;
  // Stub req.auth so TypeScript is satisfied — external routes must not use Clerk fields
  req.auth = { userId: '', orgId: null, memberRole: null };
  perKeyLimiter(req, res, next);
}

export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.apiKey?.scopes.includes(scope)) {
      res.status(403).json({ error: `Scope required: ${scope}` });
      return;
    }
    next();
  };
}
