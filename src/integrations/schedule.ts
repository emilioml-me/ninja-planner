import { safeIntegrationFetch } from './client.js';
import type { IntegrationResult, ScheduleSummary } from './types.js';

/**
 * Fetch today's appointments from ninja-schedule.
 *
 * ninja-schedule must expose:
 *   GET /api/internal/summary
 *   Authorization: Bearer <NINJA_SCHEDULE_API_KEY>
 *
 * Expected response shape: ScheduleSummary
 */
export async function fetchScheduleSummary(): Promise<IntegrationResult<ScheduleSummary>> {
  return safeIntegrationFetch<ScheduleSummary>('NINJA_SCHEDULE', '/api/internal/summary');
}
