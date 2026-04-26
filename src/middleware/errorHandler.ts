import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : 'Internal server error';

  if (status >= 500) {
    logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  }

  res.status(status).json({ error: message });
}
