import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { KanbanBoard, type KanbanCard, type KanbanColumnData } from '@/components/KanbanBoard';
import { TaskFormDialog, type Task } from '@/components/TaskFormDialog';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';

const COLUMNS: { id: Task['status']; title: string }[] = [
  { id: 'todo', title: 'To Do' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'done', title: 'Done' },
  { id: 'blocked', title: 'Blocked' },
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

export default function Tasks() {
  const { apiRequest } = useApiClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [defaultStatus, setDefaultStatus] = useState<Task['status']>('todo');

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => apiRequest<Task[]>('GET', '/api/tasks'),
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

  const columns: KanbanColumnData[] = COLUMNS.map((col) => ({
    id: col.id,
    title: col.title,
    cards: tasks.filter((t) => t.status === col.id).map(taskToCard),
  }));

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        Loading tasks…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <h1 className="text-xl font-semibold">Tasks</h1>
        <Button
          size="sm"
          className="gap-2"
          onClick={() => { setEditingTask(null); setDefaultStatus('todo'); setDialogOpen(true); }}
        >
          <Plus className="h-4 w-4" />
          New Task
        </Button>
      </div>

      <div className="flex-1 overflow-hidden">
        <KanbanBoard
          columns={columns}
          onAddCard={handleAddCard}
          onCardClick={handleCardClick}
          onReorder={handleReorder}
          onDeleteCard={(id) => deleteMutation.mutate(id)}
        />
      </div>

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingTask(null); }}
        onSubmit={handleSubmit}
        task={editingTask}
        defaultStatus={defaultStatus}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
    </div>
  );
}
