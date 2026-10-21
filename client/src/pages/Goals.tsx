import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/clerk-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { isPast } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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
import { Target, Plus, MoreVertical, Pencil, Trash2, CheckCircle2, Circle, XCircle, ChevronDown, ChevronRight, Loader2, Download, Link2, X } from 'lucide-react';
import { downloadCsv } from '@/lib/export-csv';
import { cn, safeFormat } from '@/lib/utils';
import { useMyRole } from '@/hooks/use-is-admin';
import { useTaskList } from '@/hooks/use-tasks';
import { QueryError } from '@/components/QueryError';

interface GoalLink {
  id: string;
  goal_id: string;
  entity_type: 'task' | 'roadmap_item';
  entity_id: string;
}

interface LinkableRoadmapItem { id: string; title: string; status: string }

interface KeyResult {
  id: string;
  goal_id: string;
  title: string;
  /** pg NUMERIC: arrives as a string on the wire - always read through Number(). */
  target_value: string | number;
  current_value: string | number;
  unit: string;
  position: number;
}

interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  /** Linked items (tasks + roadmap items) despite the column names. */
  total_tasks: number;
  done_tasks: number;
  created_by: string;
  created_at: string;
  /** Included by GET /api/goals (one grouped query server-side - no per-card fetch). */
  key_results?: KeyResult[];
}

const KR_MAX_VALUE = 1_000_000_000;

/** Parses a KR number input; null when blank, non-numeric, negative or above the server max. */
function parseKrValue(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= KR_MAX_VALUE ? n : null;
}

/** Progress of one KR in percent. A target of 0 is met once the current value is down to 0. */
function krProgress(kr: KeyResult): number {
  const target = Number(kr.target_value);
  const current = Number(kr.current_value);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return 0;
  if (target <= 0) return current <= 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (current / target) * 100));
}

/** Formats a NUMERIC string without trailing zeros ("12.50" -> "12.5"). */
function formatKrValue(v: string | number): string {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : String(v);
}

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  active:    { label: 'Active',    icon: Circle,        color: 'text-blue-600'  },
  completed: { label: 'Completed', icon: CheckCircle2,  color: 'text-green-600' },
  cancelled: { label: 'Cancelled', icon: XCircle,       color: 'text-gray-400'  },
};

const formSchema = z.object({
  title:       z.string().trim().min(1, 'Required').max(500),
  description: z.string().max(5000, 'Max 5000 characters').optional(),
  due_date:    z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

export default function Goals() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  // Edit controls stay hidden until the workspace role has loaded (no flash for viewers).
  const { isAdmin, isViewer, isLoading: roleLoading } = useMyRole();
  const canEdit = !roleLoading && !isViewer;
  const { userId } = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Goal | null>(null);

  const { data, isLoading: goalsLoading, isError, error, refetch } = useQuery<Goal[]>({
    queryKey: ['/api/goals'],
    queryFn: () => apiRequest('GET', '/api/goals'),
  });
  const goals = data ?? [];
  const isLoading = goalsLoading || roleLoading;
  // Exact: the list carries progress + key results; per-goal link lists are refreshed by the
  // link mutations themselves.
  const invalidateGoals = () => qc.invalidateQueries({ queryKey: ['/api/goals'], exact: true });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { title: '', description: '', due_date: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ title: '', description: '', due_date: '' });
    setOpen(true);
  };

  const openEdit = (g: Goal) => {
    setEditing(g);
    form.reset({ title: g.title, description: g.description ?? '', due_date: g.due_date?.substring(0, 10) ?? '' });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: (data: FormData) => {
      // null (not undefined) so clearing the due date on edit actually persists.
      const payload = { ...data, description: data.description?.trim() ? data.description : null, due_date: data.due_date || null };
      return editing
        ? apiRequest('PATCH', `/api/goals/${editing.id}`, payload)
        : apiRequest('POST', '/api/goals', payload);
    },
    onSuccess: () => {
      invalidateGoals();
      setOpen(false);
      toast({ title: editing ? 'Goal updated' : 'Goal created' });
    },
    onError: (err: Error) => toast({ title: editing ? 'Failed to update goal' : 'Failed to create goal', description: err.message, variant: 'destructive' }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest('PATCH', `/api/goals/${id}`, { status }),
    onSuccess: () => invalidateGoals(),
    onError: (err: Error) => toast({ title: 'Failed to update goal status', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/goals/${id}`),
    onSuccess: (_data, id) => {
      invalidateGoals();
      qc.removeQueries({ queryKey: ['/api/goals', id] });
      setDeleteTarget(null);
      toast({ title: 'Goal deleted' });
    },
    onError: (err: Error) => toast({ title: 'Failed to delete goal', description: err.message, variant: 'destructive' }),
  });

  const active    = goals.filter((g) => g.status === 'active');
  const completed = goals.filter((g) => g.status === 'completed');
  const cancelled = goals.filter((g) => g.status === 'cancelled');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Target className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Goals</h1>
            <p className="text-sm text-muted-foreground">Track objectives and link tasks to measure progress.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline" className="gap-2"
            disabled={goals.length === 0}
            title={goals.length === 0 ? 'Nothing to export yet' : undefined}
            onClick={() => downloadCsv('goals.csv', goals.map((g) => ({
              title: g.title,
              status: g.status,
              due_date: g.due_date ?? '',
              linked_items: g.total_tasks,
              done_items: g.done_tasks,
            })))}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          {canEdit && <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" />New Goal</Button>}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
        </div>
      ) : isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : goals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Target className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No goals yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create a goal to track your team's objectives.</p>
          {canEdit && <Button className="mt-4 gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Create first goal</Button>}
        </div>
      ) : (
        <>
          {[{ title: 'Active', items: active }, { title: 'Completed', items: completed }, { title: 'Cancelled', items: cancelled }]
            .filter((g) => g.items.length > 0)
            .map(({ title, items }) => (
              <div key={title} className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
                {items.map((goal) => {
                  // Server: goal delete, link removal and KR delete are admin OR goal creator.
                  const canManage = canEdit && (isAdmin || goal.created_by === userId);
                  return (
                    <GoalCard
                      key={goal.id} goal={goal} canEdit={canEdit} canManage={canManage} onEdit={openEdit}
                      onDelete={canManage ? setDeleteTarget : undefined}
                      onStatusChange={(s) => statusMutation.mutate({ id: goal.id, status: s })}
                    />
                  );
                })}
              </div>
            ))}
        </>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Goal' : 'New Goal'}</DialogTitle>
            <DialogDescription>Set an objective for your team to work towards.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))} className="space-y-4">
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem><FormLabel>Title</FormLabel><FormControl><Input placeholder="Goal title" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem><FormLabel>Description</FormLabel><FormControl><Textarea placeholder="What does success look like?" rows={3} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="due_date" render={({ field }) => (
                <FormItem><FormLabel>Due Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={saveMutation.isPending}>{saveMutation.isPending ? 'Saving...' : editing ? 'Update' : 'Create'}</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete goal?</DialogTitle>
            <DialogDescription>This will permanently delete "{deleteTarget?.title}", its key results and all its links. Linked tasks and roadmap items themselves won't be deleted.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Linked tasks / roadmap items drive the goal's progress (server counts done tasks and 'live'
// roadmap items). The link routes existed server-side but had no UI, so progress was always 0.
function GoalLinks({ goalId, canEdit, canUnlink }: { goalId: string; canEdit: boolean; canUnlink: boolean }) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [entityType, setEntityType] = useState<'task' | 'roadmap_item'>('task');
  const [search, setSearch] = useState('');

  const {
    data: linksData, isLoading, isError, error, refetch,
  } = useQuery<GoalLink[]>({
    queryKey: ['/api/goals', goalId, 'links'],
    queryFn: () => apiRequest<GoalLink[]>('GET', `/api/goals/${goalId}/links`),
  });
  const links = linksData ?? [];
  // The workspace task list comes from the shared useTaskList() cache (the only reader of
  // ['/api/tasks']); it is capped, so say so when the picker may be missing tasks.
  const {
    tasks, truncated: tasksTruncated, isError: tasksError, error: tasksErr, refetch: refetchTasks,
  } = useTaskList();
  // Distinct key suffix so this lookup doesn't share a cache entry with pages that store a
  // differently-shaped result under the bare key, while prefix invalidation still reaches it.
  const roadmapQuery = useQuery<LinkableRoadmapItem[]>({
    queryKey: ['/api/roadmap', 'goal-links'],
    queryFn: () => apiRequest<LinkableRoadmapItem[]>('GET', '/api/roadmap'),
    staleTime: 60_000,
  });
  const roadmapItems = roadmapQuery.data ?? [];

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const roadmapMap = new Map(roadmapItems.map((r) => [r.id, r]));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['/api/goals', goalId, 'links'] });
    qc.invalidateQueries({ queryKey: ['/api/goals'], exact: true });
  };

  const linkMut = useMutation({
    mutationFn: (d: { entity_type: 'task' | 'roadmap_item'; entity_id: string }) =>
      apiRequest('POST', `/api/goals/${goalId}/links`, d),
    onSuccess: () => { invalidate(); setSearch(''); },
    onError: (err: Error) => toast({ title: 'Failed to link item', description: err.message, variant: 'destructive' }),
  });

  const unlinkMut = useMutation({
    mutationFn: (entityId: string) => apiRequest('DELETE', `/api/goals/${goalId}/links/${entityId}`),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: 'Failed to unlink item', description: err.message, variant: 'destructive' }),
  });

  const linkedIds = new Set(links.map((l) => l.entity_id));
  const q = search.trim().toLowerCase();
  const candidates = (entityType === 'task' ? tasks : roadmapItems)
    .filter((c) => !linkedIds.has(c.id) && (!q || c.title.toLowerCase().includes(q)))
    .slice(0, 8);
  const pickerError = entityType === 'task'
    ? (tasksError && tasks.length === 0 ? { error: tasksErr, retry: () => refetchTasks() } : null)
    : (roadmapQuery.isError && !roadmapQuery.data ? { error: roadmapQuery.error, retry: () => roadmapQuery.refetch() } : null);

  return (
    <div className="space-y-2 pl-1">
      {isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : isError && !linksData ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : links.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing linked yet — link tasks or roadmap items to track progress.</p>
      ) : (
        links.map((l) => {
          const item = l.entity_type === 'task' ? taskMap.get(l.entity_id) : roadmapMap.get(l.entity_id);
          const done = l.entity_type === 'task' ? item?.status === 'done' : item?.status === 'live';
          return (
            <div key={l.id} className="flex items-center gap-2 text-xs group">
              {done
                ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                : <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              <span className="flex-1 truncate">{item?.title ?? '(unavailable)'}</span>
              <Badge variant="outline" className="text-[9px] px-1 shrink-0">
                {l.entity_type === 'task' ? 'Task' : 'Roadmap'}
              </Badge>
              {canEdit && canUnlink && (
                <Button
                  size="icon" variant="ghost"
                  className="h-5 w-5 opacity-50 hover:opacity-100 focus-visible:opacity-100 hover:text-destructive shrink-0"
                  disabled={unlinkMut.isPending}
                  onClick={() => unlinkMut.mutate(l.entity_id)}
                  aria-label="Unlink"
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          );
        })
      )}

      {canEdit && (adding ? (
        <div className="space-y-2 border rounded-md p-2 bg-muted/30">
          <div className="flex gap-1.5">
            <Select value={entityType} onValueChange={(v) => { setEntityType(v as 'task' | 'roadmap_item'); setSearch(''); }}>
              <SelectTrigger className="h-7 text-xs w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="task">Task</SelectItem>
                <SelectItem value="roadmap_item">Roadmap item</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Search by title…"
              className="h-7 text-xs flex-1"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setAdding(false); setSearch(''); }}>
              Done
            </Button>
          </div>
          {pickerError ? (
            <QueryError error={pickerError.error} onRetry={pickerError.retry} />
          ) : candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matching {entityType === 'task' ? 'tasks' : 'roadmap items'}.</p>
          ) : (
            <div className="space-y-0.5">
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-muted truncate disabled:opacity-50"
                  disabled={linkMut.isPending}
                  onClick={() => linkMut.mutate({ entity_type: entityType, entity_id: c.id })}
                >
                  {c.title}
                </button>
              ))}
            </div>
          )}
          {entityType === 'task' && tasksTruncated && !pickerError && (
            <p className="text-[10px] text-muted-foreground">
              Only the first {tasks.length} tasks are searchable here.
            </p>
          )}
        </div>
      ) : (
        <Button
          variant="ghost" size="sm"
          className="h-6 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="h-3 w-3" /> Link task or roadmap item
        </Button>
      ))}
    </div>
  );
}

function GoalCard({ goal, canEdit, canManage, onEdit, onDelete, onStatusChange }: {
  goal: Goal;
  canEdit: boolean;
  /** Admin or the goal's creator: may delete the goal, unlink items and delete key results. */
  canManage: boolean;
  onEdit: (g: Goal) => void;
  onDelete?: (g: Goal) => void;
  onStatusChange: (status: string) => void;
}) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [krExpanded, setKrExpanded] = useState(false);
  const [linksExpanded, setLinksExpanded] = useState(false);
  const [addingKr, setAddingKr] = useState(false);
  const [newKrTitle, setNewKrTitle] = useState('');
  const [newKrTarget, setNewKrTarget] = useState('100');
  const [newKrUnit, setNewKrUnit] = useState('%');
  const [editingKr, setEditingKr] = useState<string | null>(null);
  const [editKrCurrent, setEditKrCurrent] = useState('');

  const pct = goal.total_tasks > 0 ? Math.round((goal.done_tasks / goal.total_tasks) * 100) : 0;
  const meta = STATUS_META[goal.status] ?? STATUS_META.active;
  const StatusIcon = meta.icon;
  // Anchored at end-of-day local time, matching Tasks.tsx's overdue convention — a goal due on
  // date D isn't overdue until D has fully elapsed, not from local midnight of D itself.
  // Previously `new Date(goal.due_date)` parsed as UTC midnight, marking goals "Overdue" (and
  // displaying the wrong date) up to several hours before their due date even began locally for
  // any UTC-negative timezone — the app's own stated LATAM/Mexico target market included.
  const overdue = goal.due_date && goal.status === 'active' && isPast(new Date(goal.due_date + 'T23:59:59'));

  // Key results arrive with the goals list (GET /api/goals) - no per-card request.
  const keyResults = goal.key_results ?? [];
  const invalidateGoals = () => qc.invalidateQueries({ queryKey: ['/api/goals'], exact: true });

  const addKrMut = useMutation({
    mutationFn: (data: { title: string; target_value: number; unit: string }) =>
      apiRequest('POST', `/api/goals/${goal.id}/key-results`, data),
    onSuccess: () => {
      invalidateGoals();
      setAddingKr(false);
      setNewKrTitle('');
      setNewKrTarget('100');
      setNewKrUnit('%');
    },
    onError: (err: Error) => toast({ title: 'Failed to add key result', description: err.message, variant: 'destructive' }),
  });

  const updateKrMut = useMutation({
    mutationFn: ({ id, current_value }: { id: string; current_value: number }) =>
      apiRequest('PATCH', `/api/goals/${goal.id}/key-results/${id}`, { current_value }),
    onSuccess: () => {
      invalidateGoals();
      setEditingKr(null);
    },
    onError: (err: Error) => toast({ title: 'Failed to update key result', description: err.message, variant: 'destructive' }),
  });

  const deleteKrMut = useMutation({
    mutationFn: (id: string) =>
      apiRequest('DELETE', `/api/goals/${goal.id}/key-results/${id}`),
    onSuccess: () => {
      invalidateGoals();
      toast({ title: 'Key result removed' });
    },
    onError: (err: Error) => toast({ title: 'Failed to remove key result', description: err.message, variant: 'destructive' }),
  });

  const avgKrPct = keyResults.length > 0
    ? Math.round(keyResults.reduce((sum, kr) => sum + krProgress(kr), 0) / keyResults.length)
    : null;
  const editKrValue = parseKrValue(editKrCurrent);
  // Blank target falls back to the server default (100); anything else must be a valid number.
  const newKrTargetValue = newKrTarget.trim() === '' ? 100 : parseKrValue(newKrTarget);

  return (
    <Card className={cn(goal.status !== 'active' && 'opacity-70')}>
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <StatusIcon className={cn('h-4 w-4 mt-0.5 shrink-0', meta.color)} />
            <div className="min-w-0">
              <p className="font-medium text-sm leading-snug">{goal.title}</p>
              {goal.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{goal.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {goal.due_date && (
              <span className={cn('text-xs', overdue ? 'text-destructive font-medium' : 'text-muted-foreground')}>
                {overdue ? 'Overdue · ' : ''}{safeFormat(goal.due_date, 'MMM d')}
              </span>
            )}
            {canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-3.5 w-3.5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onEdit(goal)}><Pencil className="h-3.5 w-3.5 mr-2" />Edit</DropdownMenuItem>
                {goal.status !== 'completed' && <DropdownMenuItem onClick={() => onStatusChange('completed')}><CheckCircle2 className="h-3.5 w-3.5 mr-2" />Mark completed</DropdownMenuItem>}
                {goal.status !== 'active' && <DropdownMenuItem onClick={() => onStatusChange('active')}><Circle className="h-3.5 w-3.5 mr-2" />Reopen</DropdownMenuItem>}
                {goal.status !== 'cancelled' && <DropdownMenuItem onClick={() => onStatusChange('cancelled')}><XCircle className="h-3.5 w-3.5 mr-2" />Cancel</DropdownMenuItem>}
                {onDelete && <DropdownMenuItem className="text-destructive" onClick={() => onDelete(goal)}><Trash2 className="h-3.5 w-3.5 mr-2" />Delete</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-3">
        {/* Linked-item progress (tasks done + roadmap items live) */}
        {goal.total_tasks > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{goal.done_tasks} / {goal.total_tasks} linked items done</span>
              <span>{pct}%</span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}
        {goal.total_tasks === 0 && (
          <p className="text-xs text-muted-foreground">No tasks or roadmap items linked yet.</p>
        )}

        {/* Linked items toggle */}
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          onClick={() => setLinksExpanded((v) => !v)}
        >
          {linksExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Link2 className="h-3.5 w-3.5" /> Linked items
          {!linksExpanded && goal.total_tasks > 0 && (
            <span className="ml-auto font-medium text-foreground">{goal.total_tasks}</span>
          )}
        </button>
        {linksExpanded && <GoalLinks goalId={goal.id} canEdit={canEdit} canUnlink={canManage} />}

        {/* Key results toggle */}
        <button
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
          onClick={() => setKrExpanded((v) => !v)}
        >
          {krExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Key Results
          {avgKrPct !== null && !krExpanded && (
            <span className="ml-auto font-medium text-foreground">{avgKrPct}% avg</span>
          )}
        </button>

        {krExpanded && (
          <div className="space-y-2 pl-1">
            {keyResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No key results yet.</p>
            ) : (
              keyResults.map((kr) => {
                const krPct = Math.round(krProgress(kr));
                return (
                  <div key={kr.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs flex-1 truncate">{kr.title}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {editingKr === kr.id ? (
                          <>
                            <Input
                              type="number"
                              min={0}
                              max={KR_MAX_VALUE}
                              step="any"
                              className={cn('h-6 w-20 text-xs px-1.5', editKrValue === null && 'border-destructive')}
                              value={editKrCurrent}
                              onChange={(e) => setEditKrCurrent(e.target.value)}
                              aria-label="Current value"
                              aria-invalid={editKrValue === null}
                              title={editKrValue === null ? 'Enter a number between 0 and 1,000,000,000' : undefined}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              // A cleared/invalid value is rejected instead of silently saving 0.
                              disabled={updateKrMut.isPending || editKrValue === null}
                              onClick={() => { if (editKrValue !== null) updateKrMut.mutate({ id: kr.id, current_value: editKrValue }); }}
                              aria-label="Save current value"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditingKr(null)} aria-label="Cancel">
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="text-xs text-muted-foreground">
                              {formatKrValue(kr.current_value)}/{formatKrValue(kr.target_value)} {kr.unit}
                            </span>
                            {canEdit && (<>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 opacity-50 hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => { setEditingKr(kr.id); setEditKrCurrent(formatKrValue(kr.current_value)); }}
                              aria-label="Edit current value"
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            {/* KR delete is admin-or-goal-creator server-side. */}
                            {canManage && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 opacity-50 hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
                              onClick={() => { if (confirm(`Remove key result "${kr.title}"?`)) deleteKrMut.mutate(kr.id); }}
                              aria-label="Remove key result"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                            )}
                            </>)}
                          </>
                        )}
                      </div>
                    </div>
                    <Progress value={krPct} className="h-1" />
                  </div>
                );
              })
            )}

            {/* Add key result */}
            {!canEdit ? null : addingKr ? (
              <div className="space-y-2 border rounded-md p-2 bg-muted/30">
                <Input
                  placeholder="Key result title"
                  className="h-7 text-xs"
                  maxLength={500}
                  value={newKrTitle}
                  onChange={(e) => setNewKrTitle(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Input
                    type="number"
                    min={0}
                    max={KR_MAX_VALUE}
                    step="any"
                    placeholder="Target"
                    className={cn('h-7 text-xs w-24', newKrTargetValue === null && 'border-destructive')}
                    value={newKrTarget}
                    onChange={(e) => setNewKrTarget(e.target.value)}
                    aria-invalid={newKrTargetValue === null}
                    title={newKrTargetValue === null ? 'Enter a number between 0 and 1,000,000,000' : undefined}
                  />
                  <Input
                    placeholder="Unit"
                    className="h-7 text-xs w-20"
                    maxLength={30}
                    value={newKrUnit}
                    onChange={(e) => setNewKrUnit(e.target.value)}
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={!newKrTitle.trim() || newKrTargetValue === null || addKrMut.isPending}
                    onClick={() => {
                      // An entered 0 is kept as-is (a "get it down to zero" KR); only a blank
                      // target falls back to 100, and invalid input disables the button.
                      if (newKrTargetValue === null) return;
                      addKrMut.mutate({
                        title: newKrTitle.trim(),
                        target_value: newKrTargetValue,
                        unit: newKrUnit.trim() || '%',
                      });
                    }}
                  >
                    {addKrMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAddingKr(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setAddingKr(true)}
              >
                <Plus className="h-3 w-3" /> Add key result
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
