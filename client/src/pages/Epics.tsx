import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/use-is-admin';
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
import { Layers, Plus, MoreVertical, Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Epic {
  id: string;
  title: string;
  description: string | null;
  status: string;
  color: string;
  created_by: string;
  total_tasks: number;
  done_tasks: number;
  total_points: number;
  done_points: number;
}

const STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  active:    { label: 'Active',    variant: 'default'   },
  completed: { label: 'Completed', variant: 'secondary' },
  archived:  { label: 'Archived',  variant: 'outline'   },
};

const PRESET_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#3b82f6',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
];

const formSchema = z.object({
  title:       z.string().min(1, 'Required').max(500),
  description: z.string().optional(),
  status:      z.enum(['active', 'completed', 'archived']),
  color:       z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
type FormData = z.infer<typeof formSchema>;

function EpicFormDialog({
  open, onOpenChange, epic, onSave, isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  epic?: Epic | null;
  onSave: (data: FormData) => void;
  isPending?: boolean;
}) {
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title:       epic?.title ?? '',
      description: epic?.description ?? '',
      status:      (epic?.status ?? 'active') as FormData['status'],
      color:       epic?.color ?? '#6366f1',
    },
  });

  // Reset when opening
  useState(() => { if (open) form.reset({
    title:       epic?.title ?? '',
    description: epic?.description ?? '',
    status:      (epic?.status ?? 'active') as FormData['status'],
    color:       epic?.color ?? '#6366f1',
  }); });

  const color = form.watch('color');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{epic ? 'Edit Epic' : 'Create Epic'}</DialogTitle>
          <DialogDescription>Epics group related tasks under a single initiative.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl><Input placeholder="Epic title" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl><Textarea placeholder="Optional description" rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="color" render={({ field }) => (
                <FormItem>
                  <FormLabel>Color</FormLabel>
                  <FormControl>
                    <div className="flex gap-1.5 flex-wrap pt-1">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => field.onChange(c)}
                          className={cn(
                            'h-6 w-6 rounded-full border-2 transition-all',
                            color === c ? 'border-foreground scale-110' : 'border-transparent',
                          )}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : epic ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function Epics() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Epic | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Epic | null>(null);

  const { data: epics = [], isLoading } = useQuery<Epic[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/epics'] });

  const createMutation = useMutation({
    mutationFn: (data: FormData) => apiRequest('POST', '/api/epics', data),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: 'Epic created' }); },
    onError:   () => toast({ title: 'Failed to create epic', variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: FormData) => apiRequest('PATCH', `/api/epics/${editing!.id}`, data),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: 'Epic updated' }); },
    onError:   () => toast({ title: 'Failed to update epic', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/epics/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast({ title: 'Epic deleted' }); },
    onError:   () => toast({ title: 'Failed to delete epic', variant: 'destructive' }),
  });

  const active    = epics.filter((e) => e.status === 'active');
  const completed = epics.filter((e) => e.status === 'completed');
  const archived  = epics.filter((e) => e.status === 'archived');

  const renderGroup = (items: Epic[], label: string) => {
    if (items.length === 0) return null;
    return (
      <section key={label} className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-0.5">{label}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((epic) => {
            const pct = epic.total_tasks > 0
              ? Math.round((epic.done_tasks / epic.total_tasks) * 100)
              : 0;
            const { label: statusLabel, variant } = STATUS_META[epic.status] ?? STATUS_META.active;
            return (
              <Card key={epic.id} className="relative overflow-hidden">
                {/* Color stripe */}
                <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: epic.color }} />
                <CardHeader className="pt-4 pb-2 flex flex-row items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Layers className="h-4 w-4 shrink-0" style={{ color: epic.color }} />
                    <h3 className="font-semibold text-sm leading-tight truncate">{epic.title}</h3>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant={variant} className="text-[10px] px-1.5">{statusLabel}</Badge>
                    {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6">
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing(epic)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(epic)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {epic.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{epic.description}</p>
                  )}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{epic.done_tasks} / {epic.total_tasks} tasks</span>
                      {epic.total_points > 0 && (
                        <span>{epic.done_points} / {epic.total_points} pts</span>
                      )}
                      <span className="font-medium text-foreground">{pct}%</span>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" /> Epics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Large initiatives that group related tasks and sprints.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> New Epic
          </Button>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="pt-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : epics.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Layers className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No epics yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create an epic to group related tasks under a single initiative.
          </p>
          {isAdmin && (
            <Button className="mt-4 gap-1.5" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Create your first epic
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {renderGroup(active, 'Active')}
          {renderGroup(completed, 'Completed')}
          {renderGroup(archived, 'Archived')}
        </div>
      )}

      {/* Create dialog */}
      <EpicFormDialog
        open={open}
        onOpenChange={setOpen}
        onSave={(d) => createMutation.mutate(d)}
        isPending={createMutation.isPending}
      />

      {/* Edit dialog */}
      <EpicFormDialog
        open={!!editing}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        epic={editing}
        onSave={(d) => updateMutation.mutate(d)}
        isPending={updateMutation.isPending}
      />

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Delete epic?</DialogTitle>
            <DialogDescription>
              <strong>"{deleteTarget?.title}"</strong> will be removed. Tasks assigned to this epic
              will become unassigned. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
