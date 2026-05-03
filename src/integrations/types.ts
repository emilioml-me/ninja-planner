// ─── Shared integration types ─────────────────────────────────────────────────
// Every integration returns an IntegrationResult<T>.
// configured: false  → env vars not set, not expected to work
// configured: true, data: null → configured but the call failed (see error)
// configured: true, data: T   → healthy

export interface IntegrationResult<T> {
  configured: boolean;
  data: T | null;
  error: string | null;
}

// ─── crm-ninja (client-ninja) ─────────────────────────────────────────────────
export interface CrmSummary {
  activeClients: number;
  totalMRR: number;
  topClients: { name: string; mrr: number; stage: string }[];
}

export interface CrmDeal {
  id: string;
  name: string;
  value: number;
  currency: string;
  stage: string;         // e.g. "closed_won", "proposal", "negotiation"
  client_name: string;
  closed_at: string | null;  // ISO date string
}

export interface CrmDealsResult {
  deals: CrmDeal[];
}

// ─── payment-ninja ────────────────────────────────────────────────────────────
export interface PaymentSummary {
  currentMonthRevenue: number;
  lastMonthRevenue: number;
  transactionCount: number;
  currency: string;
}

// ─── desk-ninja ───────────────────────────────────────────────────────────────
export interface HelpdeskSummary {
  openTickets: number;
  urgentTickets: number;
  resolvedToday: number;
}

// ─── ninja-schedule ───────────────────────────────────────────────────────────
export interface ScheduleSummary {
  todayCount: number;
  upcomingToday: { title: string; time: string }[];
}

// ─── Aggregated response from GET /api/integrations/summary ──────────────────
export interface IntegrationsSummary {
  crm:      IntegrationResult<CrmSummary>;
  payments: IntegrationResult<PaymentSummary>;
  helpdesk: IntegrationResult<HelpdeskSummary>;
  schedule: IntegrationResult<ScheduleSummary>;
}

// ─── Status-only response from GET /api/integrations/status ──────────────────
export interface IntegrationsStatus {
  crm:      { configured: boolean; label: string; description: string };
  payments: { configured: boolean; label: string; description: string };
  helpdesk: { configured: boolean; label: string; description: string };
  schedule: { configured: boolean; label: string; description: string };
}
