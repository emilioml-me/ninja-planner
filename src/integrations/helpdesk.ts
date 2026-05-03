import { safeIntegrationFetch } from './client.js';
import type { IntegrationResult, HelpdeskSummary } from './types.js';

/**
 * Fetch ticket summary from desk-ninja.
 *
 * desk-ninja must expose:
 *   GET /api/internal/summary
 *   Authorization: Bearer <DESK_NINJA_API_KEY>
 *
 * Expected response shape: HelpdeskSummary
 */
export async function fetchHelpdeskSummary(): Promise<IntegrationResult<HelpdeskSummary>> {
  return safeIntegrationFetch<HelpdeskSummary>('DESK_NINJA', '/api/internal/summary');
}
