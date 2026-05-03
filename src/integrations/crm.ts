import { safeIntegrationFetch } from './client.js';
import type { IntegrationResult, CrmSummary } from './types.js';

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
