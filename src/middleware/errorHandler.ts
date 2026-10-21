import type { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger.js';

// Central Postgres error-code mapping. Route handlers pass DB errors to next(err) rather than
// hand-rolling 500s, so client-caused constraint/format failures surface as 4xx here instead of
// an opaque "Internal server error". Messages are deliberately generic — pg's own error text
// names tables/constraints/columns and must not leak to clients.
const PG_ERROR_MAP: Record<string, { status: number; message: string }> = {
  '22P02': { status: 400, message: 'Invalid input' },                  // invalid_text_representation (e.g. bad uuid)
  '22001': { status: 400, message: 'Value too long' },                 // string_data_right_truncation
  '22003': { status: 400, message: 'Number out of range' },            // numeric_value_out_of_range
  '22007': { status: 400, message: 'Invalid input' },                  // invalid_datetime_format
  '22008': { status: 400, message: 'Invalid input' },                  // datetime_field_overflow
  '23502': { status: 400, message: 'Missing required value' },         // not_null_violation
  '23505': { status: 409, message: 'Already exists' },                 // unique_violation
  '23503': { status: 400, message: 'Referenced record not found' },    // foreign_key_violation
  '23514': { status: 400, message: 'Invalid input' },                  // check_violation
  '40001': { status: 409, message: 'Please retry' },                   // serialization_failure
  '40P01': { status: 409, message: 'Please retry' },                   // deadlock_detected
  '57014': { status: 503, message: 'Request timed out, please retry' }, // query_canceled (statement_timeout)
};

// Generic texts for library-raised 4xx errors (body-parser, http-errors...). Their own messages can
// echo parser internals or request content, so they are never forwarded verbatim.
const GENERIC_4XX: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Request body too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
};

const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.parse.failed':    'Invalid JSON body',
  'entity.too.large':       'Request body too large',
  'encoding.unsupported':   'Unsupported content encoding',
  'charset.unsupported':    'Unsupported charset',
  'request.aborted':        'Request aborted',
};

/**
 * Error with an HTTP status whose message is safe to show the client. Route/service code may
 * also use the existing `Object.assign(new Error(msg), { status })` pattern (a plain Error with an
 * own `status`) — both are treated as application errors whose message is forwarded. Anything else
 * (body-parser, http-errors, SDK error subclasses) gets generic text instead.
 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function isAppError(err: unknown): err is Error {
  if (err instanceof HttpError) return true;
  return err instanceof Error
    && Object.getPrototypeOf(err) === Error.prototype
    && Object.prototype.hasOwnProperty.call(err, 'status')
    && typeof (err as { type?: unknown }).type !== 'string';
}

function pgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  // pg SQLSTATE codes are always 5 chars; guards against Node system error codes (ECONNREFUSED…)
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // A response already started (streaming, or a handler that wrote then threw) can't get a new
  // status/body — let Express's default handler close the connection.
  if (res.headersSent) {
    logger.error({ err, method: req.method, path: req.path }, 'Error after headers sent');
    next(err);
    return;
  }

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

  let message: string;
  if (status >= 500) {
    message = 'Internal server error';
  } else if (isAppError(err) && err.message) {
    message = err.message;
  } else {
    const type = (err as { type?: unknown } | null)?.type;
    message = (typeof type === 'string' ? BODY_PARSER_MESSAGES[type] : undefined)
      ?? GENERIC_4XX[status]
      ?? 'Request failed';
  }

  res.status(status).json({ error: message });
}
