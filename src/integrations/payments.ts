import { safeIntegrationFetch } from './client.js';
import type { IntegrationResult, PaymentSummary } from './types.js';

/**
 * Fetch revenue summary from payment-ninja.
 *
 * payment-ninja must expose:
 *   GET /api/internal/summary
 *   Authorization: Bearer <PAYMENT_NINJA_API_KEY>
 *
 * Expected response shape: PaymentSummary
 */
export async function fetchPaymentsSummary(): Promise<IntegrationResult<PaymentSummary>> {
  return safeIntegrationFetch<PaymentSummary>('PAYMENT_NINJA', '/api/internal/summary');
}
