// Request timezone helpers. The client sends its IANA zone in `X-Timezone` on every request so
// date-of-timestamp filters and "today" comparisons match what the user sees, instead of UTC days.
import type { Request } from 'express';

export const DEFAULT_TZ = 'America/Mexico_City';

/** True if `tz` is an IANA zone this runtime understands. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validated `X-Timezone` header value, else DEFAULT_TZ. Safe to pass as a SQL parameter. */
export function getRequestTz(req: Request): string {
  const raw = req.headers['x-timezone'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return isValidTimeZone(value) ? value : DEFAULT_TZ;
}

/** Calendar date (YYYY-MM-DD) of `date` (default now) in `tz`. */
export function todayInTz(tz: string, date: Date = new Date()): string {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
