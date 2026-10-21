import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { safeFormat } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { StatCard } from '@/components/StatCard';
import { QueryError } from '@/components/QueryError';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, MoreVertical, Pencil, Trash2, TrendingUp, Download, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadCsv } from '@/lib/export-csv';

// ─── Revenue bar chart with forecast line ────────────────────────────────────

/** Simple ordinary least squares for y = a + b*x */
function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const sumX  = points.reduce((s, p) => s + p.x, 0);
  const sumY  = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Pure calendar arithmetic on YYYY-MM-DD, returned as local YYYY-MM-DD (toISOString() is UTC and
// shifted the month for users east of UTC; setMonth also overflowed Jan 31 -> Mar 3).
function addMonths(dateStr: string, n: number): string {
  const [y, m] = dateStr.slice(0, 10).split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

/** Absolute month index (year*12 + month) of a YYYY-MM-DD string — real gaps between months count. */
function monthIndex(dateStr: string): number {
  const [y, m] = dateStr.slice(0, 10).split('-').map(Number);
  return y * 12 + (m - 1);
}

type PeriodType = 'monthly' | 'quarterly' | 'yearly';

/** `targets` must already be filtered to a single period type. */
function RevenueChart({ targets, periodType }: { targets: RevenueTarget[]; periodType: PeriodType }) {
  const sorted = [...targets]
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
    .slice(-8);

  if (sorted.length < 2) return null;

  // Forecast only for monthly rows: x is the absolute month index, so a missing month is a real
  // gap in the regression instead of being treated as adjacent. A zero in a month that has already
  // ended is a genuine zero and counts; the current/future month with 0 is just not filled in yet.
  const currentMonth = monthIndex(format(new Date(), 'yyyy-MM-dd'));
  const monthlyWithActual = periodType === 'monthly'
    ? sorted.filter((t) => Number(t.actual_amount) > 0 || monthIndex(t.period_start) < currentMonth).slice(-6)
    : [];

  const regressionPoints = monthlyWithActual.map((t) => ({ x: monthIndex(t.period_start), y: Number(t.actual_amount) }));
  const regression = regressionPoints.length >= 3 ? linearRegression(regressionPoints) : null;

  // Projected months: the 2 months after the last monthly row shown.
  const lastSortedDate = sorted[sorted.length - 1].period_start;
  const forecastMonths = regression ? [1, 2].map((offset) => {
    const period_start = addMonths(lastSortedDate, offset);
    return {
      period_start,
      projected: Math.max(0, regression.intercept + regression.slope * monthIndex(period_start)),
    };
  }) : [];

  const allForDisplay = [
    ...sorted,
    ...forecastMonths.map((f, i) => ({
      id: `forecast-${i}`,
      period_type: 'monthly',
      period_start: f.period_start,
      target_amount: '0',
      actual_amount: String(f.projected),
      notes: null,
      _forecast: true,
    } as RevenueTarget & { _forecast?: boolean })),
  ];

  const maxVal = Math.max(
    ...allForDisplay.flatMap((t) => [Number(t.target_amount), Number(t.actual_amount)]),
    1,
  );

  const W = 560, H = 140, LABEL_H = 20;
  const groupW = W / allForDisplay.length;
  const barW = Math.min(groupW * 0.32, 28);
  const gap = 3;

  function periodLabel(t: RevenueTarget & { _forecast?: boolean }) {
    const d = new Date(t.period_start + 'T00:00:00');
    if (t.period_type === 'yearly')    return String(d.getFullYear());
    if (t.period_type === 'quarterly') return `Q${Math.ceil((d.getMonth() + 1) / 3)} ${String(d.getFullYear()).slice(2)}`;
    return format(d, 'MMM yy');
  }

  // Build polyline path for actual values (only historical)
  const actualPoints = sorted
    .map((t, i) => {
      const actual = Number(t.actual_amount);
      if (!actual) return null;
      const cx = i * groupW + groupW / 2;
      return { x: cx, y: H - (actual / maxVal) * H };
    })
    .filter((p): p is { x: number; y: number } => p !== null);

  // Extend with forecast points
  const forecastPolyline = forecastMonths.map((f, i) => {
    const cx = (sorted.length + i) * groupW + groupW / 2;
    return { x: cx, y: H - (f.projected / maxVal) * H };
  });

  const trendlinePoints = actualPoints.length >= 2
    ? [...actualPoints.slice(-1), ...forecastPolyline]
    : [];

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground flex-wrap">
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--muted-foreground) / 0.25)' }} />
          Target
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--primary))' }} />
          Actual
        </div>
        {forecastMonths.length > 0 && (
          <div className="flex items-center gap-1.5">
            <svg width="18" height="10"><line x1="0" y1="5" x2="18" y2="5" stroke="hsl(var(--primary))" strokeWidth="2" strokeDasharray="4 3" strokeOpacity="0.6" /></svg>
            Forecast
          </div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H + LABEL_H}`} className="w-full overflow-visible">
        {/* Baseline */}
        <line x1="0" y1={H} x2={W} y2={H} style={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }} />

        {/* Forecast separator */}
        {forecastMonths.length > 0 && (
          <line
            x1={sorted.length * groupW} y1="0"
            x2={sorted.length * groupW} y2={H}
            stroke="hsl(var(--muted-foreground))"
            strokeOpacity="0.2"
            strokeWidth="1"
            strokeDasharray="4 3"
          />
        )}

        {/* Trend / forecast line */}
        {trendlinePoints.length >= 2 && (
          <polyline
            points={trendlinePoints.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeOpacity="0.55"
            strokeWidth="2"
            strokeDasharray="5 4"
          />
        )}

        {allForDisplay.map((t, i) => {
          const isForecast = (t as RevenueTarget & { _forecast?: boolean })._forecast;
          const target = Number(t.target_amount);
          const actual = Number(t.actual_amount);
          const targetH = (target / maxVal) * H;
          const actualH = (actual / maxVal) * H;
          const cx = i * groupW + groupW / 2;
          return (
            <g key={t.id}>
              {!isForecast && target > 0 && (
                <rect
                  x={cx - barW - gap / 2} y={H - targetH}
                  width={barW} height={targetH} rx="2"
                  style={{ fill: 'hsl(var(--muted-foreground) / 0.25)' }}
                />
              )}
              {actual > 0 && (
                <rect
                  x={cx + gap / 2} y={H - actualH}
                  width={barW} height={actualH} rx="2"
                  style={{
                    fill: isForecast ? 'hsl(var(--primary) / 0.25)' : 'hsl(var(--primary))',
                    stroke: isForecast ? 'hsl(var(--primary))' : 'none',
                    strokeWidth: isForecast ? 1.5 : 0,
                    strokeDasharray: isForecast ? '4 3' : 'none',
                  }}
                />
              )}
              <text
                x={cx} y={H + 14} textAnchor="middle"
                style={{
                  fill: isForecast ? 'hsl(var(--primary) / 0.6)' : 'hsl(var(--muted-foreground))',
                  fontSize: '10px',
                  fontStyle: isForecast ? 'italic' : 'normal',
                }}
              >
                {periodLabel(t as RevenueTarget & { _forecast?: boolean })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface RevenueTarget {
  id: string;
  period_type: string;
  period_start: string;
  target_amount: string;
  actual_amount: string;
  notes: string | null;
  actual_source?: 'crm' | 'payments' | 'manual' | null;
}

interface Capabilities {
  slack_alerts: boolean;
  payments_sync: boolean;
  crm_linked: boolean;
}

/** Revenue sync responses: `skipped` is the list of periods owned by another source. */
interface RevenueSyncResult {
  synced: number;
  skipped?: string[] | number;
  /** CRM sync: months reset to 0 because they no longer have won deals. */
  reset?: string[];
  /** CRM sync: oldest month dropped because the deal window cut it off part-way. */
  partial_month_dropped?: string | null;
  currency?: string | null;
  /** CRM sync: deals ignored (e.g. a different currency). */
  ignored_deals?: number;
}

function countOf(v: string[] | number | undefined | null): number {
  if (Array.isArray(v)) return v.length;
  return Number(v ?? 0) || 0;
}

function syncDescription(d: RevenueSyncResult): string {
  const synced = Number(d.synced) || 0;
  const parts = [`${synced} period${synced !== 1 ? 's' : ''} updated`];
  const skipped = countOf(d.skipped);
  if (skipped > 0) parts.push(`${skipped} skipped (owned by another source or edited manually)`);
  const reset = countOf(d.reset);
  if (reset > 0) parts.push(`${reset} reset to 0 (no won deals any more)`);
  const ignored = Number(d.ignored_deals ?? 0) || 0;
  if (ignored > 0) parts.push(`${ignored} deal${ignored !== 1 ? 's' : ''} ignored${d.currency ? ` (not in ${d.currency})` : ''}`);
  if (d.partial_month_dropped) parts.push(`${d.partial_month_dropped.slice(0, 7)} not updated (incomplete data)`);
  return parts.join(', ');
}

const SOURCE_LABEL: Record<string, string> = {
  crm: 'CRM',
  payments: 'Payments',
  manual: 'Manual',
};

/**
 * Snap a date to the first day of its month / quarter / year (the server does the same), so a
 * manual row and a synced row for the same period don't become two separate rows.
 */
function normalizePeriodStart(periodType: PeriodType, dateStr: string): string {
  const [y, m] = dateStr.slice(0, 10).split('-').map(Number);
  if (!y || !m) return dateStr;
  if (periodType === 'yearly') return `${y}-01-01`;
  if (periodType === 'quarterly') {
    const qm = Math.floor((m - 1) / 3) * 3 + 1;
    return `${y}-${String(qm).padStart(2, '0')}-01`;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

const MAX_AMOUNT = 9_999_999_999.99;

const formSchema = z.object({
  period_type: z.enum(['monthly', 'quarterly', 'yearly']),
  period_start: z.string().min(1, 'Required'),
  // 0 allowed: integration syncs create rows with target 0, which must stay editable.
  target_amount: z.coerce.number().finite().min(0, 'Must be >= 0').max(MAX_AMOUNT, 'Too large'),
  actual_amount: z.coerce.number().finite().min(0, 'Must be >= 0').max(MAX_AMOUNT, 'Too large').optional(),
  notes: z.string().max(2000, 'Max 2000 characters').optional(),
});
type FormData = z.infer<typeof formSchema>;
type RevenuePatch = Omit<Partial<FormData>, 'notes'> & { notes?: string | null; actual_source?: null };

function fmt(val: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(val));
}

/** Real achievement % (can exceed 100); cap only where it drives a progress bar. */
function pct(actual: string, target: string) {
  const t = Number(target);
  if (!t) return 0;
  return Math.round((Number(actual) / t) * 100);
}

export default function Revenue() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RevenueTarget | null>(null);
  // Totals, chart and table cover one period type at a time — summing monthly, quarterly and
  // yearly rows double-counts the same revenue.
  const [periodType, setPeriodType] = useState<PeriodType>('monthly');

  const { data, isLoading, isError, error, refetch } = useQuery<RevenueTarget[]>({
    queryKey: ['/api/revenue'],
    queryFn: () => apiRequest<RevenueTarget[]>('GET', '/api/revenue'),
  });
  const targets = data ?? [];

  const { data: capabilities } = useQuery<Capabilities>({
    queryKey: ['/api/integrations/capabilities'],
    queryFn: () => apiRequest<Capabilities>('GET', '/api/integrations/capabilities'),
    enabled: isAdmin,
    staleTime: 5 * 60_000,
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { period_type: 'monthly', period_start: '', target_amount: 0, actual_amount: 0, notes: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ period_type: 'monthly', period_start: '', target_amount: 0, actual_amount: 0, notes: '' });
    setOpen(true);
  };

  const openEdit = (t: RevenueTarget) => {
    setEditing(t);
    form.reset({
      period_type: t.period_type as 'monthly' | 'quarterly' | 'yearly',
      period_start: t.period_start.substring(0, 10),
      target_amount: Number(t.target_amount),
      actual_amount: Number(t.actual_amount),
      notes: t.notes ?? '',
    });
    setOpen(true);
  };

  const createMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('POST', '/api/revenue', d),
    onSuccess: (_r, d) => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); setOpen(false); setPeriodType(d.period_type); toast({ title: 'Target created' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: RevenuePatch) => apiRequest('PATCH', `/api/revenue/${editing!.id}`, d),
    onSuccess: (_r, d) => {
      qc.invalidateQueries({ queryKey: ['/api/revenue'] });
      setOpen(false);
      setEditing(null);
      // Keep the edited row visible if its period type changed.
      if (d.period_type) setPeriodType(d.period_type);
      toast({ title: 'Target updated' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/revenue/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); toast({ title: 'Target deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  // Hand a manually edited month back to the integrations (the next sync may overwrite it).
  const releaseSourceMut = useMutation({
    mutationFn: (id: string) => apiRequest('PATCH', `/api/revenue/${id}`, { actual_source: null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); toast({ title: 'Actual handed back to sync' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const syncCrmMut = useMutation({
    mutationFn: () => apiRequest<RevenueSyncResult>('POST', '/api/integrations/sync-revenue'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['/api/revenue'] });
      toast({ title: 'CRM sync complete', description: syncDescription(d) });
    },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const syncPaymentsMut = useMutation({
    mutationFn: () => apiRequest<RevenueSyncResult>('POST', '/api/integrations/sync-revenue-payments'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['/api/revenue'] });
      toast({ title: 'Payments sync complete', description: syncDescription(d) });
    },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const shown = targets.filter((t) => t.period_type === periodType);
  const totalTarget = shown.reduce((s, t) => s + Number(t.target_amount), 0);
  const totalActual = shown.reduce((s, t) => s + Number(t.actual_amount), 0);
  // Rows without a target (e.g. created by a sync) have no meaningful achievement %.
  // Average the real (uncapped) percentages so over-achievement shows.
  const withTarget = shown.filter((t) => Number(t.target_amount) > 0);
  const avgPct = withTarget.length ? Math.round(withTarget.reduce((s, t) => s + pct(t.actual_amount, t.target_amount), 0) / withTarget.length) : 0;

  const periodLabel = (t: RevenueTarget) => {
    const start = t.period_start.substring(0, 10);
    if (t.period_type === 'yearly') return start.slice(0, 4);
    if (t.period_type === 'quarterly') return `Q${Math.ceil(Number(start.slice(5, 7)) / 3)} ${start.slice(0, 4)}`;
    return safeFormat(start, 'MMM yyyy');
  };

  const handleSubmit = (d: FormData) => {
    const data: FormData = { ...d, period_start: normalizePeriodStart(d.period_type, d.period_start) };
    if (!editing) {
      createMut.mutate(data);
      return;
    }
    // Only send actual_amount when it actually changed: a PATCH of actual_amount marks the month
    // as manually owned, which stops the integrations from updating it.
    const { actual_amount, notes, ...rest } = data;
    const actualChanged = actual_amount !== undefined && Number(actual_amount) !== Number(editing.actual_amount);
    // Cleared notes must be sent as null (undefined means "unchanged").
    const payload: RevenuePatch = { ...rest, notes: notes?.trim() ? notes : null };
    if (actualChanged) payload.actual_amount = actual_amount;
    updateMut.mutate(payload);
  };

  const periodTypeColor: Record<string, string> = {
    monthly: 'default',
    quarterly: 'secondary',
    yearly: 'outline',
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Revenue</h1>
        <div className="flex items-center gap-2">
          <Select value={periodType} onValueChange={(v) => setPeriodType(v as PeriodType)}>
            <SelectTrigger className="h-8 w-32 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="yearly">Yearly</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="gap-2"
            onClick={() => downloadCsv('revenue.csv', targets.map((t) => ({
              period_type: t.period_type,
              period_start: t.period_start,
              target: t.target_amount,
              actual: t.actual_amount,
              notes: t.notes ?? '',
            })))}>
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          {isAdmin && (<>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => syncCrmMut.mutate()}
            disabled={syncCrmMut.isPending}
            title="Pull closed deals from CRM and update actual revenue"
          >
            <RefreshCw className={cn('h-4 w-4', syncCrmMut.isPending && 'animate-spin')} />
            <span className="hidden sm:inline">Sync CRM</span>
          </Button>
          {capabilities?.payments_sync && (
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => syncPaymentsMut.mutate()}
            disabled={syncPaymentsMut.isPending}
            title="Pull current/last month totals from Payments and update actual revenue"
          >
            <RefreshCw className={cn('h-4 w-4', syncPaymentsMut.isPending && 'animate-spin')} />
            <span className="hidden sm:inline">Sync Payments</span>
          </Button>
          )}
          <Button size="sm" className="gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Add Target
          </Button>
          </>)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total Target" value={fmt(String(totalTarget))} icon={<TrendingUp className="h-4 w-4" />} />
          <StatCard label="Total Actual" value={fmt(String(totalActual))} />
          <StatCard label="Avg Achievement" value={`${avgPct}%`} />
        </div>

        {/* Chart */}
        {!isLoading && !isError && <RevenueChart targets={shown} periodType={periodType} />}

        {/* Table */}
        {isError && !data ? (
          <QueryError error={error} onRetry={() => refetch()} />
        ) : isLoading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : shown.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            {targets.length === 0 ? 'No revenue targets yet.' : `No ${periodType} targets.`}
            {isAdmin && ' Add your first one.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Period</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Target</TableHead>
                <TableHead className="text-right">Actual</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((t) => {
                const p = pct(t.actual_amount, t.target_amount);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      {periodLabel(t)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={periodTypeColor[t.period_type] as 'default' | 'secondary' | 'outline'}>
                        {t.period_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(t.target_amount)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {t.actual_source && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal" title={
                            t.actual_source === 'manual'
                              ? 'Edited manually - integration syncs leave this period alone'
                              : `Synced from ${SOURCE_LABEL[t.actual_source] ?? t.actual_source}`
                          }>
                            {SOURCE_LABEL[t.actual_source] ?? t.actual_source}
                          </Badge>
                        )}
                        {fmt(t.actual_amount)}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-32">
                      <div className="flex items-center gap-2">
                        <Progress value={Math.min(100, Math.max(0, p))} className="flex-1 h-2" />
                        <span className={cn('text-xs w-10 text-right', p > 100 ? 'text-green-600 font-medium' : 'text-muted-foreground')}>{p}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-48 truncate">
                      {t.notes}
                    </TableCell>
                    <TableCell>
                      {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(t)}>
                            <Pencil className="h-4 w-4 mr-2" /> Edit
                          </DropdownMenuItem>
                          {t.actual_source === 'manual' && (
                            <DropdownMenuItem
                              disabled={releaseSourceMut.isPending}
                              onClick={() => releaseSourceMut.mutate(t.id)}
                            >
                              <RefreshCw className="h-4 w-4 mr-2" /> Let sync update actual
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => { if (confirm(`Delete the ${t.period_type} target for ${periodLabel(t)}?`)) deleteMut.mutate(t.id); }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Dialog */}
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setEditing(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Target' : 'Add Revenue Target'}</DialogTitle>
            <DialogDescription>Set a revenue goal for a specific period.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="period_type" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="monthly">Monthly</SelectItem>
                        <SelectItem value="quarterly">Quarterly</SelectItem>
                        <SelectItem value="yearly">Yearly</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="period_start" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Period Start</FormLabel>
                    <FormControl><Input type="date" {...field} /></FormControl>
                    <p className="text-[11px] text-muted-foreground">Saved as the first day of the period.</p>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="target_amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target ($)</FormLabel>
                    <FormControl><Input type="number" min="0" step="any" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="actual_amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Actual ($)</FormLabel>
                    <FormControl><Input type="number" min="0" step="any" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl><Textarea rows={2} placeholder="Optional notes…" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={createMut.isPending || updateMut.isPending}>
                  {createMut.isPending || updateMut.isPending ? 'Saving…' : editing ? 'Update' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
