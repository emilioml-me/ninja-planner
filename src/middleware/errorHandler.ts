import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

// Central Postgres error-code mapping. Route handlers pass DB errors to next(err) rather than
// hand-rolling 500s, so client-caused constraint/format failures surface as 4xx here instead of
// an opaque "Internal server error". Messages are deliberately generic — pg's own error text
// names tables/constraints/columns and must not leak to clients.
const PG_ERROR_MAP: Record<string, { status: number; message: string }> = {
  '22P02': { status: 400, message: 'Invalid input' },                  // invalid_text_representation (e.g. bad uuid)
  '22007': { status: 400, message: 'Invalid input' },                  // invalid_datetime_format
  '22008': { status: 400, message: 'Invalid input' },                  // datetime_field_overflow
  '23505': { status: 409, message: 'Already exists' },                 // unique_violation
  '23503': { status: 400, message: 'Referenced record not found' },    // foreign_key_violation
  '23514': { status: 400, message: 'Invalid input' },                  // check_violation
};

function pgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  // pg SQLSTATE codes are always 5 chars; guards against Node system error codes (ECONNREFUSED…)
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const pgCode = pgErrorCode(err);
  const mapped = pgCode ? PG_ERROR_MAP[pgCode] : undefined;
  if (mapped) {
    logger.warn({ pgCode, constraint: (err as { constraint?: string }).constraint, method: req.method, path: req.path }, 'Mapped database error');
    res.status(mapped.status).json({ error: mapped.message });
    return;
  }

  const rawStatus = (err as { status?: number } | null)?.status;
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
