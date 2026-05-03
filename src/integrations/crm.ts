import { safeIntegrationFetch } from './client.js';
import type { IntegrationResult, CrmSummary, CrmDealsResult } from './types.js';

/**
 * Fetch client/MRR summary from crm-ninja (client-ninja).
 *
 * crm-ninja must expose:
 *   GET /api/internal/summary
 *   Authorization: Bearer <CRM_NINJA_API_KEY>
 *
 * Expected response shape: CrmSummary
 */
export async function fetchCrmSummary(): Promise<IntegrationResult<CrmSummary>> {
  return safeIntegrationFetch<CrmSummary>('CRM_NINJA', '/api/internal/summary');
}

/**
 * Fetch closed/won deals from crm-ninja for revenue sync.
 *
 * crm-ninja must expose:
 *   GET /api/internal/deals?stage=closed_won
 *   Authorization: Bearer <CRM_NINJA_API_KEY>
 *
 * Expected response shape: CrmDealsResult
 */
export async function fetchCrmDeals(stage = 'closed_won'): Promise<IntegrationResult<CrmDealsResult>> {
  return safeIntegrationFetch<CrmDealsResult>('CRM_NINJA', `/api/internal/deals?stage=${encodeURIComponent(stage)}`);
}
