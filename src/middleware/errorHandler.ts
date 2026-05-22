import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const rawStatus = (err as { status?: number }).status;
  // L6: Clamp to 4xx-5xx range — prevents accidentally forwarding 1xx/2xx/3xx error statuses
  const status = (rawStatus && rawStatus >= 400 && rawStatus <= 599) ? rawStatus : 500;

  if (status >= 500) {
    logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  }

  const message = status >= 500
    ? 'Internal server error'
    : (err instanceof Error ? err.message : 'Internal server error');

  res.status(status).json({ error: message });
}
