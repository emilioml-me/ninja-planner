import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { safeFormat, todayLocal } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { QueryError } from '@/components/QueryError';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Wallet, Plus, MoreVertical, Pencil, Trash2, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { downloadCsv } from '@/lib/export-csv';
import { useAuth } from '@clerk/clerk-react';

interface Budget {
  id: string;
  name: string;
  description: string | null;
  target_amount: string;
  actual_amount: string;
  time_cost: string;
  currency: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  entry_count: number;
  epic_id: string | null;
  sprint_id: string | null;
}

interface BudgetEntry {
  id: string;
  description: string;
  amount: string;
  category: string | null;
  entry_date: string;
  created_by: string;
  display_name: string | null;
}

const NONE = '__none__';

// An empty number input must be "Required", not silently coerced to 0 (z.coerce turns '' into 0).
const requiredNumber = (max: number) => z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number({ required_error: 'Required', invalid_type_error: 'Must be a number' })
    .finite('Must be a number')
    .min(0, 'Must be >= 0')
    .max(max, `Must be <= ${max.toLocaleString('en-US')}`),
);

// Mirrors server limits in src/routes/budgets.ts (NUMERIC(14,2) target, 1e9 entry cap).
const TARGET_AMOUNT_MAX = 999_999_999_999.99;
const ENTRY_AMOUNT_MAX = 1_000_000_000;

const budgetSchema = z.object({
  name:          z.string().trim().min(1, 'Required').max(255),
  description:   z.string().max(2000, 'Max 2000 characters').optional(),
  target_amount: requiredNumber(TARGET_AMOUNT_MAX),
  currency:      z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code').default('USD'),
  period_start:  z.string().optional(),
  period_end:    z.string().optional(),
  status:        z.enum(['active', 'closed']).default('active'),
  epic_id:       z.string().default(NONE),
  sprint_id:     z.string().default(NONE),
}).refine(
  (d) => !(d.period_start && d.period_end && d.period_start > d.period_end),
  { message: 'End must be on or after start', path: ['period_end'] },
);
type BudgetForm = z.infer<typeof budgetSchema>;

const entrySchema = z.object({
  description: z.string().min(1, 'Required').max(500),
  amount:      requiredNumber(ENTRY_AMOUNT_MAX),
  category:    z.string().max(100).optional(),
  entry_date:  z.string().min(1, 'Required'),
});
type EntryForm = z.infer<typeof entrySchema>;

function fmt(amount: string | number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));
}

function BudgetFormDialog({
  open, onOpenChange, budget, onSave, isPending,
}: {
  open: boolean; onOpenChange: (v: boolean) => void;
  budget?: Budget | null; onSave: (d: BudgetForm) => void; isPending?: boolean;
}) {
  const { apiRequest } = useApiClient();
  const form = useForm<BudgetForm>({
    resolver: zodResolver(budgetSchema),
    defaultValues: {
      name: budget?.name ?? '',
      description: budget?.description ?? '',
      target_amount: budget ? Number(budget.target_amount) : 0,
      currency: budget?.currency ?? 'USD',
      period_start: budget?.period_start?.slice(0, 10) ?? '',
      period_end: budget?.period_end?.slice(0, 10) ?? '',
      status: (budget?.status ?? 'active') as 'active' | 'closed',
      epic_id: budget?.epic_id ?? NONE,
      sprint_id: budget?.sprint_id ?? NONE,
    },
  });

  const { data: epics = [] } = useQuery<{ id: string; title: string }[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
    enabled: open,
  });
  const { data: sprints = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
    enabled: open,
  });

  // Both create and edit dialogs stay mounted (only `open` toggles), and react-hook-form only
  // applies `defaultValues` on initial mount — without this, editing any budget after the dialog
  // has mounted once shows stale/blank data instead of that budget's actual values.
  useEffect(() => {
    if (!open) return;
    form.reset({
      name: budget?.name ?? '',
      description: budget?.description ?? '',
      target_amount: budget ? Number(budget.target_amount) : 0,
      currency: budget?.currency ?? 'USD',
      period_start: budget?.period_start?.slice(0, 10) ?? '',
      period_end: budget?.period_end?.slice(0, 10) ?? '',
      status: (budget?.status ?? 'active') as 'active' | 'closed',
      epic_id: budget?.epic_id ?? NONE,
      sprint_id: budget?.sprint_id ?? NONE,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budget]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{budget ? 'Edit Budget' : 'New Budget'}</DialogTitle>
          <DialogDescription>Track spending against a target for a project or initiative.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name</FormLabel>
                <FormControl><Input placeholder="Q3 Marketing Campaign" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem><FormLabel>Description</FormLabel>
                <FormControl><Textarea rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="target_amount" render={({ field }) => (
                <FormItem><FormLabel>Target Amount</FormLabel>
                  <FormControl><Input type="number" min={0} step="0.01" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="currency" render={({ field }) => (
                <FormItem><FormLabel>Currency</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="EUR">EUR</SelectItem>
                      <SelectItem value="MXN">MXN</SelectItem>
                      <SelectItem value="GBP">GBP</SelectItem>
                      {field.value && !['USD', 'EUR', 'MXN', 'GBP'].includes(field.value) && (
                        <SelectItem value={field.value}>{field.value}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="period_start" render={({ field }) => (
                <FormItem><FormLabel>Period Start</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                </FormItem>
              )} />
              <FormField control={form.control} name="period_end" render={({ field }) => (
                <FormItem><FormLabel>Period End</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="epic_id" render={({ field }) => (
                <FormItem><FormLabel>Linked Epic</FormLabel>
                  <Select onValueChange={(v) => { field.onChange(v); if (v !== NONE) form.setValue('sprint_id', NONE); }} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {epics.map((e) => <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
              <FormField control={form.control} name="sprint_id" render={({ field }) => (
                <FormItem><FormLabel>Linked Sprint</FormLabel>
                  <Select onValueChange={(v) => { field.onChange(v); if (v !== NONE) form.setValue('epic_id', NONE); }} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>None</SelectItem>
                      {sprints.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormItem>
              )} />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              Linking an epic or sprint rolls up billable logged time as estimated spend.
            </p>
            <FormField control={form.control} name="status" render={({ field }) => (
              <FormItem><FormLabel>Status</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : budget ? 'Update' : 'Create'}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function BudgetDetail({ budget }: { budget: Budget }) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [expanded, setExpanded] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const entryForm = useForm<EntryForm>({
    resolver: zodResolver(entrySchema),
    defaultValues: { description: '', amount: 0, category: '', entry_date: todayLocal() },
  });

  const {
    data: entriesData, isLoading: entriesLoading, isError: entriesIsError, error: entriesError, refetch: refetchEntries,
  } = useQuery<BudgetEntry[]>({
    queryKey: ['/api/budgets', budget.id, 'entries'],
    queryFn: () => apiRequest('GET', `/api/budgets/${budget.id}/entries`),
    enabled: expanded,
  });
  const entries = entriesData ?? [];

  const addEntry = useMutation({
    mutationFn: (d: EntryForm) => apiRequest('POST', `/api/budgets/${budget.id}/entries`, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/budgets', budget.id, 'entries'] });
      qc.invalidateQueries({ queryKey: ['/api/budgets'] });
      setAddOpen(false);
      entryForm.reset({ description: '', amount: 0, category: '', entry_date: todayLocal() });
      toast({ title: 'Expense added' });
    },
    onError: (err: Error) => toast({ title: 'Failed to add expense', description: err.message, variant: 'destructive' }),
  });

  const deleteEntry = useMutation({
    mutationFn: (entryId: string) => apiRequest('DELETE', `/api/budgets/${budget.id}/entries/${entryId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/budgets', budget.id, 'entries'] });
      qc.invalidateQueries({ queryKey: ['/api/budgets'] });
    },
    onError: (err: Error) => toast({ title: 'Failed to delete expense', description: err.message, variant: 'destructive' }),
  });

  const target = Number(budget.target_amount);
  const actual = Number(budget.actual_amount);
  const timeCost = Number(budget.time_cost ?? 0);
  const pct = target > 0 ? Math.min(Math.round((actual / target) * 100), 100) : 0;
  const over = actual > target;

  return (
    <div>
      <button
        className="w-full text-left flex items-center gap-2 py-1"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        <div className="flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate">{budget.name}</span>
              <Badge variant={budget.status === 'active' ? 'default' : 'secondary'} className="text-[10px] px-1.5">
                {budget.status}
              </Badge>
            </div>
            <div className="text-xs shrink-0 text-right">
              <span className={cn('font-medium', over && 'text-destructive')}>
                {fmt(actual, budget.currency)}
              </span>
              <span className="text-muted-foreground"> / {fmt(target, budget.currency)}</span>
            </div>
          </div>
          <Progress
            value={pct}
            className={cn('h-1.5', over && '[&>div]:bg-destructive')}
          />
          {timeCost > 0 && (
            <p className="text-[10px] text-muted-foreground">
              + {fmt(timeCost, budget.currency)} in billable logged time (not counted above)
            </p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="pl-6 pt-3 space-y-3">
          {budget.description && (
            <p className="text-xs text-muted-foreground">{budget.description}</p>
          )}
          {(budget.period_start || budget.period_end) && (
            <p className="text-xs text-muted-foreground">
              {budget.period_start && format(new Date(budget.period_start + 'T00:00:00'), 'MMM d, yyyy')}
              {budget.period_start && budget.period_end && ' → '}
              {budget.period_end && format(new Date(budget.period_end + 'T00:00:00'), 'MMM d, yyyy')}
            </p>
          )}

          <div className="flex gap-2">
            {/* The server rejects entries on closed budgets (400), so don't offer the action. */}
            {budget.status !== 'closed' && (
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1"
                onClick={() => setAddOpen(true)}>
                <Plus className="h-3 w-3" /> Add expense
              </Button>
            )}
            {entries.length > 0 && (
              <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1"
                onClick={() => downloadCsv(`budget-${budget.name.replace(/\s+/g, '-')}.csv`,
                  entries.map((e) => ({
                    date: e.entry_date, description: e.description,
                    amount: e.amount, category: e.category ?? '', by: e.display_name ?? '',
                  })))}>
                <Download className="h-3 w-3" /> Export
              </Button>
            )}
          </div>

          {addOpen && budget.status !== 'closed' && (
            <Form {...entryForm}>
              <form onSubmit={entryForm.handleSubmit((d) => addEntry.mutate(d))}
                className="border rounded-md p-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={entryForm.control} name="description" render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="text-xs">Description</FormLabel>
                      <FormControl><Input className="h-7 text-xs" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={entryForm.control} name="amount" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Amount ({budget.currency})</FormLabel>
                      <FormControl><Input type="number" min={0} step="0.01" className="h-7 text-xs" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={entryForm.control} name="category" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs">Category</FormLabel>
                      <FormControl><Input placeholder="e.g. software" className="h-7 text-xs" {...field} /></FormControl>
                    </FormItem>
                  )} />
                  <FormField control={entryForm.control} name="entry_date" render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="text-xs">Date</FormLabel>
                      <FormControl><Input type="date" required className="h-7 text-xs" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={addEntry.isPending}>
                    {addEntry.isPending ? 'Adding…' : 'Add'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
                </div>
              </form>
            </Form>
          )}

          <div className="space-y-1 max-h-52 overflow-y-auto">
            {entriesIsError && !entriesData ? (
              <QueryError error={entriesError} onRetry={() => refetchEntries()} />
            ) : entriesLoading ? (
              <Skeleton className="h-6 w-full" />
            ) : entries.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No expenses yet.</p>
            ) : (
              entries.map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-xs group rounded px-1 py-1 hover:bg-muted/40">
                  <span className="text-muted-foreground w-20 shrink-0">
                    {safeFormat(e.entry_date, 'MMM d')}
                  </span>
                  <span className="flex-1 truncate">{e.description}</span>
                  {e.category && (
                    <Badge variant="outline" className="text-[9px] px-1 shrink-0">{e.category}</Badge>
                  )}
                  <span className="font-medium shrink-0">{fmt(e.amount, budget.currency)}</span>
                  {/* The server rejects deleting entries from a closed budget (400). */}
                  {budget.status !== 'closed' && (e.created_by === userId || isAdmin) && (
                    <Button type="button" variant="ghost" size="icon"
                      aria-label={`Delete expense ${e.description}`}
                      className="h-5 w-5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                      disabled={deleteEntry.isPending}
                      onClick={() => { if (confirm(`Delete expense "${e.description}"?`)) deleteEntry.mutate(e.id); }}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Budgets() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Budget | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery<Budget[]>({
    queryKey: ['/api/budgets'],
    queryFn: () => apiRequest('GET', '/api/budgets'),
  });
  const budgets = data ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/budgets'] });

  // Empty period strings map to null (backend z.string().date() rejects "", and undefined would
  // mean "unchanged" on PATCH, so clearing a date would never persist). NONE sentinel maps to null.
  const sanitize = (d: BudgetForm) => ({
    ...d,
    description:  d.description?.trim() ? d.description : null,
    period_start: d.period_start || null,
    period_end:   d.period_end   || null,
    epic_id:      d.epic_id === NONE ? null : d.epic_id,
    sprint_id:    d.sprint_id === NONE ? null : d.sprint_id,
  });

  const createMut = useMutation({
    mutationFn: (d: BudgetForm) => apiRequest('POST', '/api/budgets', sanitize(d)),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: 'Budget created' }); },
    onError: (err: Error) => toast({ title: 'Failed to create budget', description: err.message, variant: 'destructive' }),
  });

  const updateMut = useMutation({
    mutationFn: (d: BudgetForm) => apiRequest('PATCH', `/api/budgets/${editing!.id}`, sanitize(d)),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: 'Budget updated' }); },
    onError: (err: Error) => toast({ title: 'Failed to update budget', description: err.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/budgets/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast({ title: 'Budget deleted' }); },
    onError: (err: Error) => toast({ title: 'Failed to delete budget', description: err.message, variant: 'destructive' }),
  });

  // Totals are grouped per currency (summing USD + MXN into one number is meaningless) and only
  // cover active budgets — closed budgets are finished and would skew "Remaining".
  const activeBudgets = budgets.filter((b) => b.status !== 'closed');
  const totalsByCurrency = Array.from(
    activeBudgets.reduce((m, b) => {
      const t = m.get(b.currency) ?? { target: 0, actual: 0 };
      t.target += Number(b.target_amount);
      t.actual += Number(b.actual_amount);
      m.set(b.currency, t);
      return m;
    }, new Map<string, { target: number; actual: number }>()),
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="h-6 w-6 text-primary" /> Budgets
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Track project spending against targets.</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> New Budget
          </Button>
        )}
      </div>

      {/* Summary */}
      {totalsByCurrency.length > 0 && (
        <div className="space-y-1">
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Total Target</p>
                {totalsByCurrency.map(([cur, t]) => (
                  <p key={cur} className="text-lg font-bold">{fmt(t.target, cur)}</p>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Total Spent</p>
                {totalsByCurrency.map(([cur, t]) => (
                  <p key={cur} className={cn('text-lg font-bold', t.actual > t.target && 'text-destructive')}>
                    {fmt(t.actual, cur)}
                  </p>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Remaining</p>
                {totalsByCurrency.map(([cur, t]) => (
                  <p key={cur} className={cn('text-lg font-bold', t.actual > t.target && 'text-destructive')}>
                    {fmt(Math.max(t.target - t.actual, 0), cur)}
                  </p>
                ))}
              </CardContent>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">Totals cover active budgets only, per currency.</p>
        </div>
      )}

      {/* Budget list */}
      {isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <Card><CardContent className="pt-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
      ) : budgets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Wallet className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No budgets yet</p>
          {isAdmin && (
            <Button className="mt-4 gap-1.5" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Create first budget
            </Button>
          )}
        </div>
      ) : (
        <Card>
          <CardContent className="pt-4 space-y-0 divide-y">
            {budgets.map((budget) => (
              <div key={budget.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <BudgetDetail budget={budget} />
                  </div>
                  {isAdmin && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 mt-0.5">
                          <MoreVertical className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditing(budget)}>
                          <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(budget)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Create dialog */}
      <BudgetFormDialog
        open={open} onOpenChange={setOpen}
        onSave={(d) => createMut.mutate(d)} isPending={createMut.isPending}
      />

      {/* Edit dialog */}
      <BudgetFormDialog
        open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}
        budget={editing} onSave={(d) => updateMut.mutate(d)} isPending={updateMut.isPending}
      />

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Delete budget?</DialogTitle>
            <DialogDescription>
              <strong>"{deleteTarget?.name}"</strong> and all its expense entries will be deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleteMut.isPending}
              onClick={() => deleteTarget && deleteMut.mutate(deleteTarget.id)}>
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
