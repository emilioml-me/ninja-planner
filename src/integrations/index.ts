import { getServiceConfig } from './client.js';
import { fetchCrmSummary }      from './crm.js';
import { fetchPaymentsSummary } from './payments.js';
import { fetchHelpdeskSummary } from './helpdesk.js';
import { fetchScheduleSummary } from './schedule.js';
import type { IntegrationsSummary, IntegrationsStatus } from './types.js';

export * from './types.js';

// ─── Aggregated summary (all in parallel) ────────────────────────────────────

export async function fetchAllSummaries(): Promise<IntegrationsSummary> {
  const [crm, payments, helpdesk, schedule] = await Promise.all([
    fetchCrmSummary(),
    fetchPaymentsSummary(),
    fetchHelpdeskSummary(),
    fetchScheduleSummary(),
  ]);
  return { crm, payments, helpdesk, schedule };
}

// ─── Status only (no external calls — just reads env vars) ───────────────────

export function getIntegrationsStatus(): IntegrationsStatus {
  return {
    crm: {
      configured:  !!getServiceConfig('CRM_NINJA'),
      label:       'client-ninja',
      description: 'CRM — clients, deals, MRR',
    },
    payments: {
      configured:  !!getServiceConfig('PAYMENT_NINJA'),
      label:       'payment-ninja',
      description: 'Payments — revenue, transactions',
    },
    helpdesk: {
      configured:  !!getServiceConfig('DESK_NINJA'),
      label:       'desk-ninja',
      description: 'Support — tickets, SLA',
    },
    schedule: {
      configured:  !!getServiceConfig('NINJA_SCHEDULE'),
      label:       'ninja-schedule',
      description: 'Scheduling — appointments, bookings',
    },
  };
}
