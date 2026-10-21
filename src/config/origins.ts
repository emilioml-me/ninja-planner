/**
 * Parses ALLOWED_ORIGIN into a list of origins. Normally a single origin
 * (e.g. https://ninja-planner.com), but a comma-separated list is accepted so staging/prod
 * aliases can share one config. Entries are trimmed and normalized to their URL origin;
 * malformed entries are dropped.
 *
 * Keep the canonical origin FIRST if you ever set a list: getPublicAppUrl() falls back to it.
 */
export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGIN ?? '';
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      /* ignore malformed entry */
    }
  }
  return out;
}

const DEFAULT_PUBLIC_APP_URL = 'https://ninja-planner.com';

/**
 * Canonical public base URL for links in emails/notifications/share URLs: APP_URL if set, else the
 * first ALLOWED_ORIGIN entry, else the production domain. Never has a trailing slash.
 */
export function getPublicAppUrl(): string {
  const explicit = (process.env.APP_URL ?? '').trim();
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      /* fall through to ALLOWED_ORIGIN */
    }
  }
  return getAllowedOrigins()[0] ?? DEFAULT_PUBLIC_APP_URL;
}
