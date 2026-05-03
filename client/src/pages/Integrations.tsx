import { useQueryClient } from '@tanstack/react-query';
import { useIntegrationsStatus, useIntegrationsSummary } from '@/hooks/use-integrations';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Users, CreditCard, HeadphonesIcon, CalendarDays,
  CheckCircle2, Circle, RefreshCw, Plug,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const INTEGRATION_META = {
  crm:      { icon: Users,           color: 'text-blue-500',   bg: 'bg-blue-500/10'   },
  payments: { icon: CreditCard,      color: 'text-green-500',  bg: 'bg-green-500/10'  },
  helpdesk: { icon: HeadphonesIcon,  color: 'text-orange-500', bg: 'bg-orange-500/10' },
  schedule: { icon: CalendarDays,    color: 'text-purple-500', bg: 'bg-purple-500/10' },
} as const;

type IntegrationKey = keyof typeof INTEGRATION_META;

export default function Integrations() {
  const { data: status, isLoading: statusLoading } = useIntegrationsStatus();
  const { data: summary, isLoading: summaryLoading, dataUpdatedAt } = useIntegrationsSummary();
  const queryClient = useQueryClient();

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/integrations/summary'] });
  };

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
          onClick={refresh}
          disabled={summaryLoading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', summaryLoading && 'animate-spin')} />
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
          const errored    = configured && result?.error != null;

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
                  {summaryLoading ? (
                    <Skeleton className="h-8 w-full" />
                  ) : result?.error ? (
                    <p className="text-xs text-destructive bg-destructive/10 rounded px-3 py-2">
                      {result.error}
                    </p>
                  ) : result?.data ? (
                    <IntegrationDataPreview integrationKey={key} data={result.data} />
                  ) : null}
                </CardContent>
              )}

              {!configured && (
                <CardContent className="pt-0">
                  <p className="text-xs text-muted-foreground">
                    Set <code className="bg-muted px-1 rounded text-[11px]">{key.replace(/([A-Z])/g, '_$1').toUpperCase()}_URL</code> and{' '}
                    <code className="bg-muted px-1 rounded text-[11px]">{key.replace(/([A-Z])/g, '_$1').toUpperCase()}_API_KEY</code> in your environment to enable.
                  </p>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
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
  return null;
}
