import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Zap, Plus, MoreVertical, Pencil, Trash2, ChevronDown, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMembers } from '@/hooks/use-members';

interface Sprint {
  id: string;
  name: string;
  goal: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  total_tasks: number;
  done_tasks: number;
}

interface SprintTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  assignee_clerk_id: string | null;
}

const STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  planning:  { label: 'Planning',  variant: 'outline'   },
  active:    { label: 'Active',    variant: 'default'   },
  completed: { label: 'Completed', variant: 'secondary' },
};

const formSchema = z.object({
  name:       z.string().min(1, 'Required').max(255),
  goal:       z.string().optional(),
  status:     z.enum(['planning', 'active', 'completed']),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
});
type FormData = z.infer<typeof formSchema>;

export default function Sprints() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { members } = useMembers();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Sprint | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Sprint | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data: sprints = [], isLoading } = useQuery<Sprint[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', goal: '', status: 'planning', start_date: '', end_date: '' },
  });

  const openCreate = () => {
    setEditing(null);
    form.reset({ name: '', goal: '', status: 'planning', start_date: '', end_date: '' });
    setOpen(true);
  };

  const openEdit = (s: Sprint) => {
    setEditing(s);
    form.reset({
      name: s.name, goal: s.goal ?? '', status: s.status as FormData['status'],
      start_date: s.start_date?.substring(0, 10) ?? '',
      end_date: s.end_date?.substring(0, 10) ?? '',
    });
    setOpen(true);
  };

  const saveMutation = useMutation({
    mutationFn: (data: FormData) => {
      const payload = { ...data, goal: data.goal || undefined, start_date: data.start_date || undefined, end_date: data.end_date || undefined };
      return editing
        ? apiRequest('PATCH', `/api/sprints/${editing.id}`, payload)
        : apiRequest('POST', '/api/sprints', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/sprints'] });
      setOpen(false);
      toast({ title: editing ? 'Sprint updated' : 'Sprint created' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/sprints/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/sprints'] });
      setDeleteTarget(null);
      toast({ title: 'Sprint deleted' });
    },
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Zap className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Sprints</h1>
            <p className="text-sm text-muted-foreground">Time-boxed cycles to focus the team's effort.</p>
          </div>
        </div>
        <Button onClick={openCreate} className="gap-2"><Plus className="h-4 w-4" />New Sprint</Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}</div>
      ) : sprints.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Zap className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No sprints yet</p>
          <p className="text-xs text-muted-foreground mt-1">Create a sprint to group and time-box your tasks.</p>
          <Button className="mt-4 gap-2" onClick={openCreate}><Plus className="h-4 w-4" />Create first sprint</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {sprints.map((sprint) => {
            const pct = sprint.total_tasks > 0 ? Math.round((sprint.done_tasks / sprint.total_tasks) * 100) : 0;
            const meta = STATUS_META[sprint.status] ?? STATUS_META.planning;
            const isExpanded = expanded.has(sprint.id);

            return (
              <Card key={sprint.id}>
                <CardHeader className="pb-3 pt-4 px-4">
                  <div className="flex items-start justify-between gap-3">
                    <button className="flex items-start gap-2 flex-1 min-w-0 text-left" onClick={() => toggleExpand(sprint.id)}>
                      {isExpanded ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{sprint.name}</span>
                          <Badge variant={meta.variant} className="text-xs">{meta.label}</Badge>
                        </div>
                        {sprint.goal && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{sprint.goal}</p>}
                        {(sprint.start_date || sprint.end_date) && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {sprint.start_date && format(new Date(sprint.start_date), 'MMM d')}
                            {sprint.start_date && sprint.end_date && ' → '}
                            {sprint.end_date && format(new Date(sprint.end_date), 'MMM d, yyyy')}
                          </p>
                        )}
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-muted-foreground">{sprint.done_tasks}/{sprint.total_tasks}</span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7"><MoreVertical className="h-3.5 w-3.5" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openEdit(sprint)}><Pencil className="h-3.5 w-3.5 mr-2" />Edit</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(sprint)}><Trash2 className="h-3.5 w-3.5 mr-2" />Delete</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {sprint.total_tasks > 0 && (
                    <div className="mt-2 pl-6">
                      <Progress value={pct} className="h-1.5" />
                    </div>
                  )}
                </CardHeader>

                {isExpanded && (
                  <CardContent className="pt-0 px-4 pb-4">
                    <SprintTaskList sprintId={sprint.id} memberMap={memberMap} />
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Sprint' : 'New Sprint'}</DialogTitle>
            <DialogDescription>Sprints are time-boxed periods to focus your team.</DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))} className="space-y-4">
              <FormField control={form.control} name="name" render={({ field }) => (
                <FormItem><FormLabel>Name</FormLabel><FormControl><Input placeholder="Sprint 1 · Q2 Bug Bash" {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="goal" render={({ field }) => (
                <FormItem><FormLabel>Sprint Goal</FormLabel><FormControl><Textarea placeholder="What should we achieve?" rows={2} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="planning">Planning</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="start_date" render={({ field }) => (
                  <FormItem><FormLabel>Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="end_date" render={({ field }) => (
                  <FormItem><FormLabel>End Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
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
            <DialogTitle>Delete sprint?</DialogTitle>
            <DialogDescription>"{deleteTarget?.name}" will be deleted. Tasks won't be deleted — they'll be unassigned from this sprint.</DialogDescription>
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

const STATUS_COLORS: Record<string, string> = {
  todo:        'bg-slate-200 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-700',
  done:        'bg-green-100 text-green-700',
  blocked:     'bg-red-100 text-red-700',
};

function SprintTaskList({ sprintId, memberMap }: { sprintId: string; memberMap: Record<string, { display_name: string }> }) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { data: tasks = [], isLoading } = useQuery<SprintTask[]>({
    queryKey: ['/api/sprints', sprintId, 'tasks'],
    queryFn: () => apiRequest('GET', `/api/sprints/${sprintId}/tasks`),
  });

  const removeMutation = useMutation({
    mutationFn: (taskId: string) => apiRequest('DELETE', `/api/sprints/${sprintId}/tasks/${taskId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/sprints', sprintId, 'tasks'] });
      qc.invalidateQueries({ queryKey: ['/api/sprints'] });
    },
  });

  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (tasks.length === 0) return <p className="text-xs text-muted-foreground pl-6">No tasks in this sprint. Assign tasks via the Tasks page.</p>;

  return (
    <div className="space-y-1.5 pl-6">
      {tasks.map((task) => (
        <div key={task.id} className="flex items-center gap-2 text-sm group">
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', STATUS_COLORS[task.status] ?? 'bg-muted text-muted-foreground')}>
            {task.status.replace('_', ' ')}
          </span>
          <span className="flex-1 min-w-0 truncate">{task.title}</span>
          {task.assignee_clerk_id && (
            <span className="text-xs text-muted-foreground shrink-0">
              {memberMap[task.assignee_clerk_id]?.display_name?.split(' ')[0] ?? '—'}
            </span>
          )}
          <Button
            variant="ghost" size="icon" className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
            onClick={() => removeMutation.mutate(task.id)}
          >
            <X className="h-3 w-3 text-muted-foreground" />
          </Button>
        </div>
      ))}
    </div>
  );
}
