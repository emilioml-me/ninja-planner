import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format, isPast } from 'date-fns';
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
import { Target, Plus, MoreVertical, Pencil, Trash2, CheckCircle2, Circle, XCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsAdmin } from '@/hooks/use-is-admin';

interface Goal {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_date: string | null;
  total_tasks: number;
  done_tasks: number;
  created_at: string;
}

interface KeyResult {
  id: string;
  goal_id: string;
  title: string;
  target_value: number;
  current_value: number;
  unit: string;
  position: number;
}

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  active:    { label: 'Active',    icon: Circle,        color: 'text-blue-600'  },
  completed: { label: 'Completed', icon: CheckCircle2,  color: 'text-green-600' },
  cancelled: { label: 'Cancelled', icon: XCircle,       color: 'text-gray-400'  },
};

const formSchema = z.object({
  title:       z.string().min(1, 'Required').max(500),
  description: z.string().optional(),
  due_date:    z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

export default function Goals() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Goal | null>(null);

  const { data: goals = [], isLoading } = useQuery<Goal[]>({
    queryKey: ['/api/goals'],
    queryFn: () => apiRequest('GET', '/api/goals'),
  });

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
      const payload = { ...data, due_date: data.due_date || undefined };
      return editing
        ? apiRequest('PATCH', `/api/goals/${editing.id}`, payload)
        : apiRequest('POST', '/api/goals', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/goals'] });
      setOpen(false);
      toast({ title: editing ? 'Goal updated' : 'Goal created' });
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiRequest('PATCH', `/api/goals/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/goals'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/goals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/goals'] });
      setDeleteTarget(null);
      toast({ title: 'Goal deleted' });
    },
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
        <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" />New Goal</Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
        </div>
      ) : goals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Target className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No goals yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create a goal to track your team's objectives.</p>
          <Button className="mt-4 gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Create first goal</Button>
        </div>
      ) : (
        <>
          {[{ title: 'Active', items: active }, { title: 'Completed', items: completed }, { title: 'Cancelled', items: cancelled }]
            .filter((g) => g.items.length > 0)
            .map(({ title, items }) => (
              <div key={title} className="space-y-3">
                <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{title}</h2>
                {items.map((goal) => <GoalCard key={goal.id} goal={goal} onEdit={openEdit} onDelete={isAdmin ? setDeleteTarget : undefined} onStatusChange={(s) => statusMutation.mutate({ id: goal.id, status: s })} />)}
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
            <DialogDescription>This will permanently delete "{deleteTarget?.title}" and all its task links. Tasks themselves won't be deleted.</DialogDescription>
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

function GoalCard({ goal, onEdit, onDelete, onStatusChange }: {
  goal: Goal;
  onEdit: (g: Goal) => void;
  onDelete?: (g: Goal) => void;
  onStatusChange: (status: string) => void;
}) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [krExpanded, setKrExpanded] = useState(false);
  const [addingKr, setAddingKr] = useState(false);
  const [newKrTitle, setNewKrTitle] = useState('');
  const [newKrTarget, setNewKrTarget] = useState('100');
  const [newKrUnit, setNewKrUnit] = useState('%');
  const [editingKr, setEditingKr] = useState<string | null>(null);
  const [editKrCurrent, setEditKrCurrent] = useState('');

  const pct = goal.total_tasks > 0 ? Math.round((goal.done_tasks / goal.total_tasks) * 100) : 0;
  const meta = STATUS_META[goal.status] ?? STATUS_META.active;
  const StatusIcon = meta.icon;
  const overdue = goal.due_date && goal.status === 'active' && isPast(new Date(goal.due_date));

  const { data: keyResults = [], isLoading: krLoading } = useQuery<KeyResult[]>({
    queryKey: ['/api/goals', goal.id, 'key-results'],
    queryFn: () => apiRequest<KeyResult[]>('GET', `/api/goals/${goal.id}/key-results`),
    enabled: krExpanded,
    staleTime: 30_000,
  });

  const addKrMut = useMutation({
    mutationFn: (data: { title: string; target_value: number; unit: string }) =>
      apiRequest('POST', `/api/goals/${goal.id}/key-results`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/goals', goal.id, 'key-results'] });
      setAddingKr(false);
      setNewKrTitle('');
      setNewKrTarget('100');
      setNewKrUnit('%');
    },
  });

  const updateKrMut = useMutation({
    mutationFn: ({ id, current_value }: { id: string; current_value: number }) =>
      apiRequest('PATCH', `/api/goals/${goal.id}/key-results/${id}`, { current_value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/goals', goal.id, 'key-results'] });
      setEditingKr(null);
    },
  });

  const deleteKrMut = useMutation({
    mutationFn: (id: string) =>
      apiRequest('DELETE', `/api/goals/${goal.id}/key-results/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/goals', goal.id, 'key-results'] });
      toast({ title: 'Key result removed' });
    },
  });

  const avgKrPct = keyResults.length > 0
    ? Math.round(keyResults.reduce((sum, kr) => {
        const t = kr.target_value > 0 ? kr.target_value : 1;
        return sum + Math.min(100, (kr.current_value / t) * 100);
      }, 0) / keyResults.length)
    : null;

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
                {overdue ? 'Overdue · ' : ''}{format(new Date(goal.due_date), 'MMM d')}
              </span>
            )}
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
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 space-y-3">
        {/* Task progress */}
        {goal.total_tasks > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{goal.done_tasks} / {goal.total_tasks} tasks done</span>
              <span>{pct}%</span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        )}
        {goal.total_tasks === 0 && (
          <p className="text-xs text-muted-foreground">No tasks linked yet.</p>
        )}

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
            {krLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : keyResults.length === 0 ? (
              <p className="text-xs text-muted-foreground">No key results yet.</p>
            ) : (
              keyResults.map((kr) => {
                const t = kr.target_value > 0 ? kr.target_value : 1;
                const krPct = Math.min(100, Math.round((kr.current_value / t) * 100));
                return (
                  <div key={kr.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs flex-1 truncate">{kr.title}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {editingKr === kr.id ? (
                          <>
                            <Input
                              type="number"
                              className="h-6 w-20 text-xs px-1.5"
                              value={editKrCurrent}
                              onChange={(e) => setEditKrCurrent(e.target.value)}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              disabled={updateKrMut.isPending}
                              onClick={() => updateKrMut.mutate({ id: kr.id, current_value: parseFloat(editKrCurrent) || 0 })}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditingKr(null)}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="text-xs text-muted-foreground">
                              {kr.current_value}/{kr.target_value} {kr.unit}
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 opacity-50 hover:opacity-100"
                              onClick={() => { setEditingKr(kr.id); setEditKrCurrent(String(kr.current_value)); }}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 opacity-50 hover:opacity-100 hover:text-destructive"
                              onClick={() => deleteKrMut.mutate(kr.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
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
            {addingKr ? (
              <div className="space-y-2 border rounded-md p-2 bg-muted/30">
                <Input
                  placeholder="Key result title"
                  className="h-7 text-xs"
                  value={newKrTitle}
                  onChange={(e) => setNewKrTitle(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-1.5">
                  <Input
                    type="number"
                    placeholder="Target"
                    className="h-7 text-xs w-24"
                    value={newKrTarget}
                    onChange={(e) => setNewKrTarget(e.target.value)}
                  />
                  <Input
                    placeholder="Unit"
                    className="h-7 text-xs w-20"
                    value={newKrUnit}
                    onChange={(e) => setNewKrUnit(e.target.value)}
                  />
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={!newKrTitle.trim() || addKrMut.isPending}
                    onClick={() => addKrMut.mutate({
                      title: newKrTitle.trim(),
                      target_value: parseFloat(newKrTarget) || 100,
                      unit: newKrUnit.trim() || '%',
                    })}
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
