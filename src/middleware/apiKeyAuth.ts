// API key auth middleware — for /api/external/* routes consumed by third-party integrations
import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../config/db.js';

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Dedicated brute-force guard — the global app-wide limiter (200/min) is far too
// permissive for guessing a fixed-format secret key.
export const apiKeyAuthLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later' },
});

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: {
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
  const { rows } = await pool.query(
    `SELECT workspace_id, scopes FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL`,
    [hash],
  ).catch(() => ({ rows: [] as { workspace_id: string; scopes: string[] }[] }));

  if (rows.length === 0) { res.status(401).json({ error: 'Invalid or revoked API key' }); return; }

  const ws = await pool.query<{ id: string; name: string; plan: string }>(
    'SELECT id, name, plan FROM workspaces WHERE id = $1',
    [rows[0].workspace_id],
  ).catch(() => ({ rows: [] as { id: string; name: string; plan: string }[] }));

  if (ws.rows.length === 0) { res.status(401).json({ error: 'Workspace not found' }); return; }

  // Fire-and-forget usage timestamp update
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1', [hash]).catch(() => {});

  req.apiKey   = { workspace_id: rows[0].workspace_id, scopes: rows[0].scopes };
  req.workspace = ws.rows[0];
  // Stub req.auth so TypeScript is satisfied — external routes must not use Clerk fields
  req.auth = { userId: '', orgId: null, memberRole: null };
  next();
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
