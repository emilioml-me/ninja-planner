import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
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

// ─── Revenue bar chart (no external deps) ────────────────────────────────────

function RevenueChart({ targets }: { targets: RevenueTarget[] }) {
  const sorted = [...targets]
    .sort((a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime())
    .slice(-8);

  if (sorted.length < 2) return null;

  const maxVal = Math.max(
    ...sorted.flatMap((t) => [Number(t.target_amount), Number(t.actual_amount)]),
    1,
  );

  const W = 560, H = 140, LABEL_H = 20;
  const groupW = W / sorted.length;
  const barW = Math.min(groupW * 0.32, 28);
  const gap = 3;

  function periodLabel(t: RevenueTarget) {
    const d = new Date(t.period_start + 'T00:00:00');
    if (t.period_type === 'yearly')    return String(d.getFullYear());
    if (t.period_type === 'quarterly') return `Q${Math.ceil((d.getMonth() + 1) / 3)} ${String(d.getFullYear()).slice(2)}`;
    return format(d, 'MMM yy');
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--muted-foreground) / 0.25)' }} />
          Target
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-2.5 rounded-sm" style={{ background: 'hsl(var(--primary))' }} />
          Actual
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H + LABEL_H}`} className="w-full overflow-visible">
        {/* Baseline */}
        <line x1="0" y1={H} x2={W} y2={H} style={{ stroke: 'hsl(var(--border))', strokeWidth: 1 }} />
        {sorted.map((t, i) => {
          const target = Number(t.target_amount);
          const actual = Number(t.actual_amount);
          const targetH = (target / maxVal) * H;
          const actualH = (actual / maxVal) * H;
          const cx = i * groupW + groupW / 2;
          return (
            <g key={t.id}>
              <rect
                x={cx - barW - gap / 2} y={H - targetH}
                width={barW} height={targetH} rx="2"
                style={{ fill: 'hsl(var(--muted-foreground) / 0.25)' }}
              />
              <rect
                x={cx + gap / 2} y={H - actualH}
                width={barW} height={actualH} rx="2"
                style={{ fill: 'hsl(var(--primary))' }}
              />
              <text
                x={cx} y={H + 14} textAnchor="middle"
                style={{ fill: 'hsl(var(--muted-foreground))', fontSize: '10px' }}
              >
                {periodLabel(t)}
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
                      {format(new Date(t.period_start), 'MMM yyyy')}
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
