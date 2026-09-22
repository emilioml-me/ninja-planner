import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useIntegrationsStatus, useIntegrationsSummary } from '@/hooks/use-integrations';
import type { IntegrationsSummary } from '@/types/integrations';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Users, CreditCard, HeadphonesIcon, CalendarDays, Zap,
  CheckCircle2, Circle, RefreshCw, Plug, Link2,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const INTEGRATION_META = {
  crm:       { icon: Users,           color: 'text-blue-500',   bg: 'bg-blue-500/10' },
  payments:  { icon: CreditCard,      color: 'text-green-500',  bg: 'bg-green-500/10' },
  helpdesk:  { icon: HeadphonesIcon,  color: 'text-orange-500', bg: 'bg-orange-500/10' },
  schedule:  { icon: CalendarDays,    color: 'text-purple-500', bg: 'bg-purple-500/10' },
  ninjatask: { icon: Zap,             color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
} as const;

type IntegrationKey = keyof typeof INTEGRATION_META;

export default function Integrations() {
  const { data: status, isLoading: statusLoading } = useIntegrationsStatus();
  const {
    data: summary, isLoading: summaryLoading, isFetching: summaryFetching, isError: summaryIsError, dataUpdatedAt,
  } = useIntegrationsSummary();
  const queryClient = useQueryClient();
  const { apiRequest } = useApiClient();
  const { toast } = useToast();

  // A plain invalidate would just re-hit the server's 5-minute cache; ?refresh=1 bypasses it.
  const refreshMut = useMutation({
    mutationFn: () => apiRequest<IntegrationsSummary>('GET', '/api/integrations/summary?refresh=1'),
    onSuccess: (data) => {
      queryClient.setQueryData(['/api/integrations/summary'], data);
    },
    onError: (e: Error) => toast({ title: 'Refresh failed', description: e.message, variant: 'destructive' }),
  });
  const refreshing = summaryFetching || refreshMut.isPending;

  const keys = Object.keys(INTEGRATION_META) as IntegrationKey[];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Plug className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Integrations</h1>
            <p className="text-sm text-muted-foreground">
              Connect ninja suite apps to surface data here.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => refreshMut.mutate()}
          disabled={refreshing}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground">
          Last refreshed {new Date(dataUpdatedAt).toLocaleTimeString()}
          {' · '}Data is cached for 5 minutes on the server.
        </p>
      )}

      <div className="grid gap-4">
        {keys.map((key) => {
          const meta   = INTEGRATION_META[key];
          const Icon   = meta.icon;
          const info   = status?.[key];
          const result = summary?.[key];

          const configured = info?.configured ?? false;
          const healthy    = configured && result?.data != null;
          // A failed summary request (or a configured slot that came back with neither data nor
          // an error) is an error state — not a spinner that never resolves.
          const pending    = configured && !result && (summaryLoading || refreshing);
          const errored    = configured && !healthy && !pending;
          const errorText  = result?.error
            ?? (summaryIsError ? 'Could not load integration data' : 'No data returned');

          return (
            <Card key={key} className={cn(!configured && 'opacity-60')}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', meta.bg)}>
                      <Icon className={cn('h-5 w-5', meta.color)} />
                    </div>
                    <div>
                      <CardTitle className="text-sm font-semibold">
                        {statusLoading ? <Skeleton className="h-4 w-24" /> : info?.label ?? key}
                      </CardTitle>
                      <CardDescription className="text-xs">
                        {statusLoading ? <Skeleton className="h-3 w-32 mt-1" /> : info?.description}
                      </CardDescription>
                    </div>
                  </div>

                  {statusLoading ? (
                    <Skeleton className="h-5 w-20 rounded-full" />
                  ) : configured ? (
                    healthy ? (
                      <Badge variant="secondary" className="gap-1 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-400">
                        <CheckCircle2 className="h-3 w-3" /> Connected
                      </Badge>
                    ) : errored ? (
                      <Badge variant="destructive" className="gap-1">
                        Error
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1">
                        <RefreshCw className="h-3 w-3 animate-spin" /> Fetching
                      </Badge>
                    )
                  ) : (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      <Circle className="h-3 w-3" /> Not configured
                    </Badge>
                  )}
                </div>
              </CardHeader>

              {configured && (
                <CardContent className="pt-0">
                  {pending ? (
                    <Skeleton className="h-8 w-full" />
                  ) : result?.data ? (
                    <IntegrationDataPreview integrationKey={key} data={result.data} />
                  ) : errored ? (
                    <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">
                      {errorText}
                    </p>
                  ) : null}
                </CardContent>
              )}

              {!configured && (
                <CardContent className="pt-0">
                  <p className="text-xs text-muted-foreground">
                    This integration is not available for your workspace.
                  </p>
                </CardContent>
              )}

              {key === 'crm' && configured && <CrmTenantLink />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/**
 * crm-ninja has no multi-tenant concept of its own — its API scopes every query by a single
 * crm-ninja user id sent as X-Tenant-ID, so this workspace must be explicitly linked to one
 * before the CRM card above (and revenue sync) can show real data instead of "not linked" errors.
 */
function CrmTenantLink() {
  const isAdmin = useIsAdmin();
  const { apiRequest } = useApiClient();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');

  const { data } = useQuery<{ tenantId: number | null }>({
    queryKey: ['/api/integrations/crm-tenant'],
    queryFn: () => apiRequest<{ tenantId: number | null }>('GET', '/api/integrations/crm-tenant'),
    enabled: isAdmin,
  });

  const mutation = useMutation({
    mutationFn: (body: { tenantId: number | null; code?: string }) =>
      apiRequest('PATCH', '/api/integrations/crm-tenant', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/crm-tenant'] });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/summary'] });
      toast({ title: 'CRM tenant updated' });
      setInput('');
      setCode('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (!isAdmin) return null;
  // One parse used for both validation and submit (previously Number() vs parseInt() disagreed,
  // e.g. "1e3" validated as 1000 but was submitted as 1).
  const trimmedInput  = input.trim();
  const parsedTenantId = /^\d{1,10}$/.test(trimmedInput) ? Number(trimmedInput) : NaN;
  const validTenantId = Number.isSafeInteger(parsedTenantId) && parsedTenantId > 0 && parsedTenantId <= 2147483647;

  return (
    <CardContent className="pt-0 border-t">
      <div className="flex items-center gap-2 pt-3">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {data?.tenantId != null ? (
          <>
            <p className="text-xs text-muted-foreground flex-1">
              Linked to crm-ninja user <span className="font-mono font-medium">#{data.tenantId}</span>
            </p>
            <Button
              variant="ghost" size="sm" className="h-7 text-xs"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ tenantId: null })}
            >
              Unlink
            </Button>
          </>
        ) : (
          <div className="flex flex-col gap-1.5 flex-1">
            <p className="text-xs text-muted-foreground">
              Ask the crm-ninja user to generate a linking code (Settings → Integrations →
              ninja-planner) and enter both below.
            </p>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                placeholder="crm-ninja user id"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                className="h-7 text-xs max-w-[140px]"
              />
              <Input
                placeholder="linking code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-7 text-xs max-w-[120px] font-mono"
              />
              <Button
                variant="outline" size="sm" className="h-7 text-xs shrink-0"
                disabled={mutation.isPending || !validTenantId || !code.trim()}
                onClick={() => mutation.mutate({ tenantId: parsedTenantId, code: code.trim() })}
              >
                Link
              </Button>
            </div>
          </div>
        )}
      </div>
    </CardContent>
  );
}

function IntegrationDataPreview({ integrationKey, data }: { integrationKey: IntegrationKey; data: unknown }) {
  if (integrationKey === 'crm') {
    const d = data as import('@/types/integrations').CrmSummary;
    return (
      <div className="flex gap-6 text-sm">
        <div><p className="text-xs text-muted-foreground">Active clients</p><p className="font-semibold">{d.activeClients}</p></div>
        <div><p className="text-xs text-muted-foreground">Total MRR</p><p className="font-semibold">${d.totalMRR.toLocaleString()}</p></div>
      </div>
    );
  }
  if (integrationKey === 'payments') {
    const d = data as import('@/types/integrations').PaymentSummary;
    return (
      <div className="flex gap-6 text-sm">
        <div><p className="text-xs text-muted-foreground">This month</p><p className="font-semibold">{d.currency} {d.currentMonthRevenue.toLocaleString()}</p></div>
        <div><p className="text-xs text-muted-foreground">Transactions</p><p className="font-semibold">{d.transactionCount}</p></div>
      </div>
    );
  }
  if (integrationKey === 'helpdesk') {
    const d = data as import('@/types/integrations').HelpdeskSummary;
    return (
      <div className="flex gap-6 text-sm">
        <div><p className="text-xs text-muted-foreground">Open tickets</p><p className="font-semibold">{d.openTickets}</p></div>
        <div><p className="text-xs text-muted-foreground">Urgent</p><p className={cn('font-semibold', d.urgentTickets > 0 && 'text-destructive')}>{d.urgentTickets}</p></div>
        <div><p className="text-xs text-muted-foreground">Resolved today</p><p className="font-semibold text-green-600">{d.resolvedToday}</p></div>
      </div>
    );
  }
  if (integrationKey === 'schedule') {
    const d = data as import('@/types/integrations').ScheduleSummary;
    return (
      <div className="flex gap-6 text-sm">
        <div><p className="text-xs text-muted-foreground">Today</p><p className="font-semibold">{d.todayCount} appointments</p></div>
      </div>
    );
  }
  if (integrationKey === 'ninjatask') {
    const d = data as import('@/types/integrations').NinjaTaskSummary;
    return (
      <div className="flex gap-6 text-sm">
        <div><p className="text-xs text-muted-foreground">Level</p><p className="font-semibold">{d.level}</p></div>
        <div><p className="text-xs text-muted-foreground">XP</p><p className="font-semibold">{d.xp.toLocaleString()}</p></div>
        <div><p className="text-xs text-muted-foreground">Coins</p><p className="font-semibold">{d.coins.toLocaleString()}</p></div>
      </div>
    );
  }
  return null;
}
