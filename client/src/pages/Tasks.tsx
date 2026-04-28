import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { KanbanBoard, type KanbanCard, type KanbanColumnData } from '@/components/KanbanBoard';
import { TaskFormDialog, type Task, type WorkspaceMember } from '@/components/TaskFormDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

const COLUMNS: { id: Task['status']; title: string }[] = [
  { id: 'todo',        title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'done',        title: 'Done' },
  { id: 'blocked',     title: 'Blocked' },
];

const PRIORITIES: Array<{ value: Task['priority'] | 'all'; label: string }> = [
  { value: 'all',    label: 'All' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'high',   label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low',    label: 'Low' },
];

function taskToCard(task: Task): KanbanCard {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    tags: task.tags,
    position: task.position,
    status: task.status,
    priority: task.priority,
    due_date: task.due_date,
    assignee_clerk_id: task.assignee_clerk_id,
  };
}

function TasksSkeleton() {
  return (
    <div className="flex gap-6 p-6">
      {COLUMNS.map((col) => (
        <div key={col.id} className="flex flex-col min-w-80">
          <div className="flex items-center gap-2 mb-4">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-6 rounded-full" />
          </div>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Tasks() {
  const { apiRequest } = useApiClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo');
  const [search, setSearch] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<Task['priority'] | 'all'>('all');

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => apiRequest<Task[]>('GET', '/api/tasks'),
  });

  const { data: members = [] } = useQuery<WorkspaceMember[]>({
    queryKey: ['/api/workspaces/me/members'],
    queryFn: () => apiRequest<WorkspaceMember[]>('GET', '/api/workspaces/me/members'),
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<Task> & { title: string }) =>
      apiRequest<Task>('POST', '/api/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      setDialogOpen(false);
      toast({ title: 'Task created' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Task> & { id: string; title: string }) =>
      apiRequest<Task>('PATCH', `/api/tasks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      setDialogOpen(false);
      setEditingTask(null);
      toast({ title: 'Task updated' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/tasks/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      toast({ title: 'Task deleted' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const reorderMutation = useMutation({
    mutationFn: (payload: {
      taskId: string;
      newStatus: string;
      newPosition: number;
      resequence?: Array<{ id: string; position: number }>;
    }) => apiRequest('POST', '/api/tasks/reorder', payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/tasks'] }),
    onError: (err: Error) => toast({ title: 'Reorder failed', description: err.message, variant: 'destructive' }),
  });

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (search && !t.title.toLowerCase().includes(search.toLowerCase())) return false;
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      return true;
    });
  }, [tasks, search, priorityFilter]);

  const columns: KanbanColumnData[] = COLUMNS.map((col) => ({
    id: col.id,
    title: col.title,
    cards: filteredTasks.filter((t) => t.status === col.id).map(taskToCard),
  }));

  const hasFilters = search !== '' || priorityFilter !== 'all';

  const clearFilters = () => {
    setSearch('');
    setPriorityFilter('all');
  };

  const handleAddCard = (columnId: string) => {
    setEditingTask(null);
    setDefaultStatus(columnId as Task['status']);
    setDialogOpen(true);
  };

  const handleCardClick = (cardId: string) => {
    const task = tasks.find((t) => t.id === cardId);
    if (task) { setEditingTask(task); setDialogOpen(true); }
  };

  const handleReorder = (
    cardId: string,
    newStatus: string,
    newPosition: number,
    resequence?: Array<{ id: string; position: number }>,
  ) => {
    reorderMutation.mutate({ taskId: cardId, newStatus, newPosition, resequence });
  };

  const handleSubmit = (data: Partial<Task> & { title: string }) => {
    if (editingTask) {
      updateMutation.mutate({ ...data, id: editingTask.id });
    } else {
      createMutation.mutate({ ...data, status: data.status ?? defaultStatus });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b gap-4">
        <h1 className="text-xl font-semibold shrink-0">Tasks</h1>
        <div className="flex items-center gap-2 flex-1 max-w-xl">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search tasks…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          {hasFilters && (
            <Button variant="ghost" size="icon" onClick={clearFilters} title="Clear filters">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <Button
          size="sm"
          className="gap-2 shrink-0"
          onClick={() => { setEditingTask(null); setDefaultStatus('todo'); setDialogOpen(true); }}
        >
          <Plus className="h-4 w-4" />
          <span className="hidden sm:inline">New Task</span>
        </Button>
      </div>

      {/* Priority filter pills */}
      <div className="flex items-center gap-1.5 px-4 sm:px-6 py-2 border-b overflow-x-auto">
        {PRIORITIES.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setPriorityFilter(value)}
            className={cn(
              'shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              priorityFilter === value
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {label}
          </button>
        ))}
        {hasFilters && (
          <span className="text-xs text-muted-foreground ml-1">
            {filteredTasks.length} of {tasks.length} tasks
          </span>
        )}
      </div>

      {/* Board */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <TasksSkeleton />
        ) : (
          <KanbanBoard
            columns={columns}
            onAddCard={handleAddCard}
            onCardClick={handleCardClick}
            onReorder={handleReorder}
            onDeleteCard={(id) => deleteMutation.mutate(id)}
          />
        )}
      </div>

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingTask(null); }}
        onSubmit={handleSubmit}
        task={editingTask}
        defaultStatus={defaultStatus}
        isPending={createMutation.isPending || updateMutation.isPending}
        members={members}
      />
    </div>
  );
}
