import type { Request, Response, NextFunction } from 'express';

export const ADMIN_ROLES = new Set(['org:admin', 'org:owner']);

/**
 * Middleware that rejects requests from non-admin workspace members with 403.
 * Must be used after requireWorkspace (which sets req.auth.memberRole).
 * Accepts both 'org:admin' and 'org:owner' roles.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth.memberRole || !ADMIN_ROLES.has(req.auth.memberRole)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
