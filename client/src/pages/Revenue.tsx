import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { safeFormat } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { StatCard } from '@/components/StatCard';
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

function addMonths(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

function RevenueChart({ targets }: { targets: RevenueTarget[] }) {
  const monthlyTargets = targets.filter((t) => t.period_type === 'monthly');

  const sorted = [...targets]
    .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime())
    .slice(-8);

  if (sorted.length < 2) return null;

  // Build forecast from monthly actuals with real values
  const monthlyWithActual = [...monthlyTargets]
    .filter((t) => Number(t.actual_amount) > 0)
    .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime())
    .slice(-6); // use last 6 data points

  const regressionPoints = monthlyWithActual.map((t, i) => ({ x: i, y: Number(t.actual_amount) }));
  const regression = regressionPoints.length >= 3 ? linearRegression(regressionPoints) : null;

  // Projected months: 2 months after the last in `sorted`
  const lastSortedDate = sorted[sorted.length - 1].period_start;
  const forecastMonths = regression ? [1, 2].map((offset) => ({
    period_start: addMonths(lastSortedDate, offset),
    projected: Math.max(0, regression.intercept + regression.slope * (regressionPoints.length - 1 + offset)),
  })) : [];

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
}

const formSchema = z.object({
  period_type: z.enum(['monthly', 'quarterly', 'yearly']),
  period_start: z.string().min(1, 'Required'),
  target_amount: z.coerce.number().positive('Must be positive'),
  actual_amount: z.coerce.number().min(0).optional(),
  notes: z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

function fmt(val: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(val));
}

function pct(actual: string, target: string) {
  const t = Number(target);
  if (!t) return 0;
  return Math.min(100, Math.round((Number(actual) / t) * 100));
}

export default function Revenue() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RevenueTarget | null>(null);

  const { data: targets = [], isLoading } = useQuery<RevenueTarget[]>({
    queryKey: ['/api/revenue'],
    queryFn: () => apiRequest<RevenueTarget[]>('GET', '/api/revenue'),
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); setOpen(false); toast({ title: 'Target created' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: FormData) => apiRequest('PATCH', `/api/revenue/${editing!.id}`, d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); setOpen(false); setEditing(null); toast({ title: 'Target updated' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/revenue/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/api/revenue'] }); toast({ title: 'Target deleted' }); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const syncCrmMut = useMutation({
    mutationFn: () => apiRequest<{ synced: number }>('POST', '/api/integrations/sync-revenue'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['/api/revenue'] });
      toast({ title: `CRM sync complete`, description: `${d.synced} period${d.synced !== 1 ? 's' : ''} updated` });
    },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const syncPaymentsMut = useMutation({
    mutationFn: () => apiRequest<{ synced: number }>('POST', '/api/integrations/sync-revenue-payments'),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['/api/revenue'] });
      toast({ title: `Payments sync complete`, description: `${d.synced} period${d.synced !== 1 ? 's' : ''} updated` });
    },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const totalTarget = targets.reduce((s, t) => s + Number(t.target_amount), 0);
  const totalActual = targets.reduce((s, t) => s + Number(t.actual_amount), 0);
  const avgPct = targets.length ? Math.round(targets.reduce((s, t) => s + pct(t.actual_amount, t.target_amount), 0) / targets.length) : 0;

  const handleSubmit = (d: FormData) => {
    editing ? updateMut.mutate(d) : createMut.mutate(d);
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
          <Button size="sm" className="gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Add Target
          </Button>
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
        {!isLoading && <RevenueChart targets={targets} />}

        {/* Table */}
        {isLoading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : targets.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">No revenue targets yet. Add your first one.</div>
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
              {targets.map((t) => {
                const p = pct(t.actual_amount, t.target_amount);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      {safeFormat(t.period_start, 'MMM yyyy')}
                    </TableCell>
                    <TableCell>
                      <Badge variant={periodTypeColor[t.period_type] as 'default' | 'secondary' | 'outline'}>
                        {t.period_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{fmt(t.target_amount)}</TableCell>
                    <TableCell className="text-right">{fmt(t.actual_amount)}</TableCell>
                    <TableCell className="min-w-32">
                      <div className="flex items-center gap-2">
                        <Progress value={p} className="flex-1 h-2" />
                        <span className="text-xs text-muted-foreground w-9 text-right">{p}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-48 truncate">
                      {t.notes}
                    </TableCell>
                    <TableCell>
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
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => deleteMut.mutate(t.id)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
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
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="target_amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target ($)</FormLabel>
                    <FormControl><Input type="number" min="0" step="100" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="actual_amount" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Actual ($)</FormLabel>
                    <FormControl><Input type="number" min="0" step="100" {...field} /></FormControl>
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
