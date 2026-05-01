import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, isBefore, isToday, startOfDay } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useMembers } from '@/hooks/use-members';
import { KanbanBoard, type KanbanCard, type KanbanColumnData } from '@/components/KanbanBoard';
import { TaskFormDialog, type Task } from '@/components/TaskFormDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Plus, Search, X, LayoutGrid, List, MoreVertical, Pencil, Trash2, Clock, Calendar } from 'lucide-react';
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

// ─── List view ────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked',
};
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  todo: 'outline', in_progress: 'default', done: 'secondary', blocked: 'destructive',
};
const PRIORITY_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  low: 'outline', medium: 'secondary', high: 'default', urgent: 'destructive',
};

function TaskListView({
  tasks,
  onEdit,
  onDelete,
  displayName,
  initials,
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  displayName: (id: string | null | undefined) => string;
  initials: (id: string | null | undefined) => string;
}) {
  const now = new Date();
  const todayStart = startOfDay(now);

  const sorted = [...tasks].sort((a, b) => {
    // Overdue first, then due today, then by position
    const aOverdue = a.due_date && isBefore(new Date(a.due_date + 'T23:59:59'), todayStart) && a.status !== 'done';
    const bOverdue = b.due_date && isBefore(new Date(b.due_date + 'T23:59:59'), todayStart) && b.status !== 'done';
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    return a.position - b.position;
  });

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
        <p className="text-sm">No tasks match your filters.</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((task) => {
            const isOverdue = task.due_date && task.status !== 'done' &&
              isBefore(new Date(task.due_date + 'T23:59:59'), todayStart);
            const dueToday = task.due_date && isToday(new Date(task.due_date));
            return (
              <TableRow
                key={task.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onEdit(task)}
              >
                <TableCell className="font-medium max-w-64 truncate">{task.title}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[task.status]} className="text-xs">
                    {STATUS_LABEL[task.status]}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={PRIORITY_VARIANT[task.priority]} className="text-xs capitalize">
                    {task.priority}
                  </Badge>
                </TableCell>
                <TableCell>
                  {task.assignee_clerk_id ? (
                    <div className="flex items-center gap-2">
                      <Avatar className="h-6 w-6">
                        <AvatarFallback className="text-xs">{initials(task.assignee_clerk_id)}</AvatarFallback>
                      </Avatar>
                      <span className="text-xs text-muted-foreground">{displayName(task.assignee_clerk_id)}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  {task.due_date ? (
                    <span className={cn(
                      'text-xs flex items-center gap-1',
                      isOverdue ? 'text-destructive font-medium' : dueToday ? 'text-yellow-600' : 'text-muted-foreground',
                    )}>
                      {isOverdue ? <Clock className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                      {format(new Date(task.due_date), 'MMM d')}
                    </span>
                  ) : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {task.tags.slice(0, 2).map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">#{tag}</Badge>
                    ))}
                    {task.tags.length > 2 && (
                      <span className="text-xs text-muted-foreground">+{task.tags.length - 2}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <MoreVertical className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onEdit(task)}>
                        <Pencil className="h-4 w-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onClick={() => onDelete(task.id)}>
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
  const [view, setView] = useState<'kanban' | 'list'>('kanban');

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => apiRequest<Task[]>('GET', '/api/tasks'),
  });

  const { members, displayName, initials } = useMembers();

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
        <div className="flex items-center gap-2 shrink-0">
          {/* View toggle */}
          <div className="flex rounded-md border overflow-hidden">
            <button
              onClick={() => setView('kanban')}
              className={cn('px-2.5 py-1.5 transition-colors', view === 'kanban' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
              title="Kanban view"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              onClick={() => setView('list')}
              className={cn('px-2.5 py-1.5 transition-colors border-l', view === 'list' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
              title="List view"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <Button
            size="sm"
            className="gap-2"
            onClick={() => { setEditingTask(null); setDefaultStatus('todo'); setDialogOpen(true); }}
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Task</span>
          </Button>
        </div>
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

      {/* Board / List */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <TasksSkeleton />
        ) : view === 'kanban' ? (
          <KanbanBoard
            columns={columns}
            onAddCard={handleAddCard}
            onCardClick={handleCardClick}
            onReorder={handleReorder}
            onDeleteCard={(id) => deleteMutation.mutate(id)}
            members={members}
          />
        ) : (
          <TaskListView
            tasks={filteredTasks}
            onEdit={(task) => { setEditingTask(task); setDialogOpen(true); }}
            onDelete={(id) => deleteMutation.mutate(id)}
            displayName={displayName}
            initials={initials}
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
