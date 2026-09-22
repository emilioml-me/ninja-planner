import type { Request, Response, NextFunction } from 'express';

/**
 * Platform (ninja-stack operator) admins — Clerk user ids from env PLATFORM_ADMIN_USER_IDS
 * (comma-separated). Unset/empty => nobody. Distinct from workspace admins: workspace admins
 * must never be able to grant their own workspace a free paid plan.
 */
export function isPlatformAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const ids = (process.env.PLATFORM_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(userId);
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!isPlatformAdmin(req.auth?.userId)) {
    res.status(403).json({ error: 'Platform admin access required' });
    return;
  }
  next();
}
