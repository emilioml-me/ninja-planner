// Mirror of src/integrations/types.ts — kept in sync manually.
// Frontend uses this for type-safe integration data consumption.

export interface IntegrationResult<T> {
  configured: boolean;
  data: T | null;
  error: string | null;
}

export interface CrmSummary {
  activeClients: number;
  totalMRR: number;
  topClients: { name: string; mrr: number; stage: string }[];
}

export interface PaymentSummary {
  currentMonthRevenue: number;
  lastMonthRevenue: number;
  transactionCount: number;
  currency: string;
}

export interface HelpdeskSummary {
  openTickets: number;
  urgentTickets: number;
  resolvedToday: number;
}

export interface ScheduleSummary {
  todayCount: number;
  upcomingToday: { title: string; time: string }[];
}

export interface NinjaTaskSummary {
  level: number;
  xp: number;
  coins: number;
}

export interface IntegrationsSummary {
  crm:       IntegrationResult<CrmSummary>;
  payments:  IntegrationResult<PaymentSummary>;
  helpdesk:  IntegrationResult<HelpdeskSummary>;
  schedule:  IntegrationResult<ScheduleSummary>;
  ninjatask: IntegrationResult<NinjaTaskSummary>;
}

export interface IntegrationsStatus {
  crm:       { configured: boolean; label: string; description: string };
  payments:  { configured: boolean; label: string; description: string };
  helpdesk:  { configured: boolean; label: string; description: string };
  schedule:  { configured: boolean; label: string; description: string };
  ninjatask: { configured: boolean; label: string; description: string };
}
