/**
 * Parses ALLOWED_ORIGIN into a list of origins. Normally a single origin
 * (e.g. https://ninja-planner.com), but a comma-separated list is accepted so staging/prod
 * aliases can share one config. Entries are trimmed and normalized to their URL origin;
 * malformed entries are dropped.
 *
 * Note: other code (email links, workspaceUrl) reads ALLOWED_ORIGIN directly as a single URL —
 * keep the canonical origin FIRST if you ever set a list.
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
