import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware that rejects requests from non-admin workspace members with 403.
 * Must be used after requireWorkspace (which sets req.auth.memberRole).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth.memberRole !== 'org:admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
