import { getServiceConfig } from './client.js';
import { fetchCrmSummary }      from './crm.js';
import { fetchPaymentsSummary } from './payments.js';
import { fetchHelpdeskSummary } from './helpdesk.js';
import { fetchScheduleSummary } from './schedule.js';
import { getNinjaTaskProfile } from './ninjatask.js';
import { isOperatorWorkspace } from '../lib/operator.js';
import type { IntegrationsSummary, IntegrationsStatus, IntegrationResult, CrmSummary, NinjaTaskSummary } from './types.js';

export * from './types.js';
export * from './ninjatask.js';

// ─── Aggregated summary (all in parallel) ────────────────────────────────────

/**
 * crmTenantId is the calling workspace's linked crm-ninja user id (workspaces.crm_ninja_tenant_id)
 * — null if the workspace hasn't been linked to a CRM tenant yet, in which case the crm slot
 * reports that distinctly from "not configured" (env vars unset) or "fetch failed".
 *
 * clerkId is the requesting user's own Clerk id, used to fetch THEIR ninja-task profile —
 * previously this always returned a hardcoded {level:0,xp:0,coins:0} stub regardless of who
 * asked, never actually calling getNinjaTaskProfile.
 */
/**
 * payments/helpdesk/schedule are backed by a single GLOBAL service key with no tenant scoping —
 * their data belongs to the platform operator. They are only fetched for operator workspaces
 * (OPERATOR_WORKSPACE_IDS); every other workspace sees them as "not configured".
 */
const NOT_CONFIGURED = { configured: false, data: null, error: null } as const;

export async function fetchAllSummaries(
  workspaceId: string,
  crmTenantId: number | null,
  clerkId: string,
): Promise<IntegrationsSummary> {
  const operator = isOperatorWorkspace(workspaceId);
  const ninjataskPromise: Promise<IntegrationResult<NinjaTaskSummary>> = (async () => {
    if (!getServiceConfig('NINJA_TASK')) return { configured: false, data: null, error: null };
    const profile = await getNinjaTaskProfile(clerkId);
    return profile
      ? { configured: true, data: { level: profile.level, xp: profile.xp, coins: profile.coins }, error: null }
      : { configured: true, data: null, error: 'ninja-task profile fetch failed' };
  })();

  const crmPromise: Promise<IntegrationResult<CrmSummary>> = crmTenantId === null
    ? Promise.resolve(
        getServiceConfig('CRM_NINJA')
          ? { configured: true, data: null, error: 'Workspace is not linked to a CRM tenant yet' }
          : { configured: false, data: null, error: null },
      )
    : fetchCrmSummary(crmTenantId);

  const [crm, payments, helpdesk, schedule, ninjatask] = await Promise.all([
    crmPromise,
    operator ? fetchPaymentsSummary() : Promise.resolve({ ...NOT_CONFIGURED }),
    operator ? fetchHelpdeskSummary() : Promise.resolve({ ...NOT_CONFIGURED }),
    operator ? fetchScheduleSummary() : Promise.resolve({ ...NOT_CONFIGURED }),
    ninjataskPromise,
  ]);
  return { crm, payments, helpdesk, schedule, ninjatask };
}

// ─── Status only (no external calls — just reads env vars) ───────────────────

export function getIntegrationsStatus(workspaceId: string): IntegrationsStatus {
  const operator = isOperatorWorkspace(workspaceId);
  return {
    crm: {
      configured:  !!getServiceConfig('CRM_NINJA'),
      label:       'client-ninja',
      description: 'CRM — clients, deals, MRR',
    },
    payments: {
      configured:  operator && !!getServiceConfig('PAYMENT_NINJA'),
      label:       'payment-ninja',
      description: 'Payments — revenue, transactions',
    },
    helpdesk: {
      configured:  operator && !!getServiceConfig('DESK_NINJA'),
      label:       'desk-ninja',
      description: 'Support — tickets, SLA',
    },
    schedule: {
      configured:  operator && !!getServiceConfig('NINJA_SCHEDULE'),
      label:       'ninja-schedule',
      description: 'Scheduling — appointments, bookings',
    },
    ninjatask: {
      configured:  !!getServiceConfig('NINJA_TASK'),
      label:       'ninja-task',
      description: 'Gamified tasks — sync planner tasks, quests & GTD',
    },
  };
}
