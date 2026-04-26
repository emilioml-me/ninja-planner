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
import { Plus, MoreVertical, Pencil, Trash2, TrendingUp } from 'lucide-react';

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
        <Button size="sm" className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> Add Target
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Total Target" value={fmt(String(totalTarget))} icon={<TrendingUp className="h-4 w-4" />} />
          <StatCard label="Total Actual" value={fmt(String(totalActual))} />
          <StatCard label="Avg Achievement" value={`${avgPct}%`} />
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground text-sm">Loading…</div>
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
