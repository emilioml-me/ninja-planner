import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { isBefore, isToday, startOfDay, addDays, format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useMembers } from '@/hooks/use-members';
import { useMyRole } from '@/hooks/use-is-admin';
import { TASK_LIST_LIMIT } from '@/hooks/use-tasks';
import { TaskFormDialog, type Task } from '@/components/TaskFormDialog';
import { QueryError } from '@/components/QueryError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Clock, Calendar, CheckCircle2, AlertCircle, Inbox, Plus, FileText, AlertTriangle } from 'lucide-react';
import { cn, localDateOnly, safeFormat, todayLocal } from '@/lib/utils';

interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: Task['priority'];
  tags: string[];
  checklist: { id: string; text: string; done: boolean }[];
}

const OPEN_STATUSES = ['todo', 'in_progress', 'blocked'] as const;

const STATUS_LABEL: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked',
};
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  todo: 'outline', in_progress: 'default', done: 'secondary', blocked: 'destructive',
};
const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'text-red-600', high: 'text-orange-500', medium: 'text-yellow-600', low: 'text-green-600',
};

interface TaskGroup {
  label: string;
  icon: React.ElementType;
  iconClass: string;
  tasks: Task[];
}

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  const todayStart = startOfDay(new Date());
  const isOverdue = task.due_date && task.status !== 'done' &&
    isBefore(new Date(task.due_date + 'T23:59:59'), todayStart);
  const dueToday = task.due_date && isToday(localDateOnly(task.due_date));

  return (
    <div
      className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors group"
      onClick={onClick}
    >
      <div className="mt-0.5 shrink-0">
        {task.status === 'done' ? (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        ) : task.status === 'blocked' ? (
          <AlertCircle className="h-4 w-4 text-destructive" />
        ) : (
          <div className={cn(
            'h-4 w-4 rounded-full border-2',
            isOverdue ? 'border-destructive' : 'border-muted-foreground/50 group-hover:border-primary',
          )} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className={cn(
          'text-sm font-medium truncate',
          task.status === 'done' && 'line-through text-muted-foreground',
        )}>
          {task.title}
        </p>

        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge variant={STATUS_VARIANT[task.status]} className="text-xs h-5">
            {STATUS_LABEL[task.status]}
          </Badge>
          {task.priority && task.priority !== 'medium' && (
            <span className={cn('text-xs capitalize font-medium', PRIORITY_COLOR[task.priority])}>
              {task.priority}
            </span>
          )}
          {task.due_date && (
            <span className={cn(
              'text-xs flex items-center gap-1',
              isOverdue ? 'text-destructive font-medium' : dueToday ? 'text-yellow-600' : 'text-muted-foreground',
            )}>
              {isOverdue ? <Clock className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
              {safeFormat(task.due_date, 'MMM d')}
            </span>
          )}
          {task.tags.slice(0, 2).map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs h-5">#{tag}</Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MyTasks() {
  const { userId } = useAuth();
  const { apiRequest, apiRequestWithHeaders } = useApiClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { members } = useMembers();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  // Filtered server-side (?assignee=) -- filtering the capped workspace-wide list client-side
  // silently dropped the user's tasks once the workspace had more than the list cap. Open
  // statuses are fetched separately (the API filters one status at a time) so done tasks can't
  // consume the cap; done tasks are only counted (limit=1 + X-Total-Count).
  const openQueries = useQueries({
    queries: OPEN_STATUSES.map((status) => ({
      queryKey: ['/api/tasks', 'assignee', userId, 'status', status],
      queryFn: async () => {
        const { data, headers } = await apiRequestWithHeaders<Task[]>(
          'GET',
          `/api/tasks?assignee=${encodeURIComponent(userId ?? '')}&status=${status}&limit=${TASK_LIST_LIMIT}`,
        );
        const total = Number(headers.get('X-Total-Count'));
        return { tasks: data, total: Number.isFinite(total) && total > 0 ? total : data.length };
      },
      enabled: !!userId,
    })),
  });
  const doneCountQuery = useQuery<number>({
    queryKey: ['/api/tasks', 'assignee', userId, 'status', 'done', 'count'],
    queryFn: async () => {
      const { data, headers } = await apiRequestWithHeaders<Task[]>(
        'GET',
        `/api/tasks?assignee=${encodeURIComponent(userId ?? '')}&status=done&limit=1`,
      );
      const total = Number(headers.get('X-Total-Count'));
      return Number.isFinite(total) && headers.get('X-Total-Count') !== null ? total : data.length;
    },
    enabled: !!userId,
  });

  const isLoading = !userId || openQueries.some((q) => q.isLoading);
  const failedQuery = openQueries.find((q) => q.isError && !q.data);
  const tasks: Task[] = openQueries.flatMap((q) => q.data?.tasks ?? []);
  const truncatedStatuses = openQueries.filter((q) => q.data && q.data.total > q.data.tasks.length).length;
  const totalOpen = openQueries.reduce((s, q) => s + (q.data?.total ?? 0), 0);
  const truncated = truncatedStatuses > 0;

  const { isViewer, isLoading: roleLoading } = useMyRole();
  const canEdit = !roleLoading && !isViewer;

  const { data: templates = [] } = useQuery<TaskTemplate[]>({
    queryKey: ['/api/task-templates'],
    queryFn: () => apiRequest<TaskTemplate[]>('GET', '/api/task-templates'),
    enabled: canEdit,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Task> & { id: string }) =>
      apiRequest<Task>('PATCH', `/api/tasks/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sprints'] });
      setDialogOpen(false);
      setEditingTask(null);
      toast({ title: 'Task updated' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const createMutation = useMutation({
    mutationFn: (data: Partial<Task> & { title: string }) =>
      apiRequest<Task>('POST', '/api/tasks', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sprints'] });
      setDialogOpen(false);
      toast({ title: 'Task created' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const openTask = (task: Task) => {
    setEditingTask(task);
    setDialogOpen(true);
  };

  // New tasks from this page default to "assigned to me" by pre-filling the form (a draft with
  // id '' opens the create form); whatever the user picks in the form is then respected.
  const openNewTask = () => {
    setEditingTask({
      id: '',
      title: '',
      description: null,
      status: 'todo',
      priority: 'medium',
      tags: [],
      position: 0,
      assignee_clerk_id: userId ?? null,
      due_date: null,
    });
    setDialogOpen(true);
  };

  const handleSelectTemplate = (tpl: TaskTemplate) => {
    setTemplatePickerOpen(false);
    setEditingTask({
      id: '',
      title: tpl.title,
      description: tpl.description,
      status: 'todo',
      priority: tpl.priority,
      tags: tpl.tags,
      checklist: tpl.checklist.map((item) => ({ ...item, done: false })),
      assignee_clerk_id: userId ?? null,
      due_date: null,
      position: 0,
      created_by: '',
      workspace_id: '',
      sprint_id: null,
      recurrence_rule: null,
      created_at: '',
      updated_at: '',
      deleted_at: null,
    } as Task);
    setDialogOpen(true);
  };

  const myTasks = tasks.filter((t) => t.assignee_clerk_id === userId);

  // Compare LOCAL calendar days as YYYY-MM-DD strings so every task lands in exactly one group
  // (previously a task due exactly 7 days out matched neither "This Week" nor "Later").
  const today = todayLocal();
  const weekEnd = format(addDays(startOfDay(new Date()), 7), 'yyyy-MM-dd');
  const dueDay = (t: Task) => (t.due_date ? t.due_date.substring(0, 10) : null);

  const overdue  = myTasks.filter((t) => { const d = dueDay(t); return d !== null && d < today; });
  const dueToday = myTasks.filter((t) => dueDay(t) === today);
  const upcoming = myTasks.filter((t) => { const d = dueDay(t); return d !== null && d > today && d <= weekEnd; });
  const later    = myTasks.filter((t) => { const d = dueDay(t); return d === null || d > weekEnd; });

  const groups: TaskGroup[] = [
    { label: 'Overdue',     icon: Clock,     iconClass: 'text-destructive',  tasks: overdue  },
    { label: 'Due Today',   icon: AlertCircle, iconClass: 'text-yellow-500', tasks: dueToday },
    { label: 'This Week',   icon: Calendar,  iconClass: 'text-blue-500',     tasks: upcoming },
    { label: 'Later',       icon: Inbox,     iconClass: 'text-muted-foreground', tasks: later },
  ];

  const handleSubmit = (data: Partial<Task>) => {
    // editingTask?.id (not just editingTask) — the template picker sets editingTask to a
    // draft object with id: '' to pre-fill the create form, which must still create, not update.
    if (editingTask?.id) {
      updateMutation.mutate({ ...data, id: editingTask.id });
    } else {
      // Respect the assignee chosen in the form (it is pre-filled with the current user).
      createMutation.mutate({ ...data, title: data.title ?? '' });
    }
  };

  const totalActive = Math.max(totalOpen, myTasks.length);
  const doneCount = doneCountQuery.data ?? 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div>
          <h1 className="text-xl font-semibold">My Tasks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {totalActive} active · {doneCount} done
            {overdue.length > 0 && (
              <span className="text-destructive ml-2 font-medium">· {overdue.length} overdue</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && templates.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => setTemplatePickerOpen(true)}
            >
              <FileText className="h-4 w-4" />
              <span className="hidden sm:inline">From Template</span>
            </Button>
          )}
          {canEdit && (
            <Button
              size="sm"
              className="gap-2"
              onClick={openNewTask}
            >
              <Plus className="h-4 w-4" />
              New Task
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {truncated && (
          <div className="mb-4 flex items-center gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Showing {tasks.length} of {Math.max(totalOpen, tasks.length)} open tasks assigned to you; the rest are not listed.
          </div>
        )}
        {failedQuery ? (
          <QueryError
            error={failedQuery.error}
            onRetry={() => { for (const q of openQueries) if (q.isError) void q.refetch(); }}
          />
        ) : isLoading ? (
          <div className="space-y-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>
            ))}
          </div>
        ) : myTasks.length === 0 && doneCount === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm font-medium">No tasks assigned to you</p>
            <p className="text-xs text-muted-foreground">
              {canEdit ? 'Create a task or ask a teammate to assign one.' : 'Tasks assigned to you will show up here.'}
            </p>
            {canEdit && (
              <Button size="sm" className="mt-2 gap-2" onClick={openNewTask}>
                <Plus className="h-4 w-4" /> Create task
              </Button>
            )}
          </div>
        ) : myTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500/60" />
            <p className="text-sm font-medium">All caught up</p>
            <p className="text-xs text-muted-foreground">
              You have no open tasks — {doneCount} completed.
            </p>
            {canEdit && (
              <Button size="sm" variant="outline" className="mt-2 gap-2" onClick={openNewTask}>
                <Plus className="h-4 w-4" /> Create task
              </Button>
            )}
          </div>
        ) : (
          <div className="max-w-2xl space-y-6">
            {groups.map((group) => (
              <section key={group.label} className="space-y-2">
                {group.tasks.length > 0 && (
                  <>
                    <div className="flex items-center gap-2">
                      <group.icon className={cn('h-4 w-4', group.iconClass)} />
                      <h2 className="text-sm font-semibold">{group.label}</h2>
                      <span className="text-xs text-muted-foreground">({group.tasks.length})</span>
                    </div>
                    <div className="space-y-2 pl-6">
                      {group.tasks.map((task) => (
                        <TaskCard key={task.id} task={task} onClick={() => openTask(task)} />
                      ))}
                    </div>
                  </>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingTask(null); }}
        onSubmit={handleSubmit}
        task={editingTask}
        defaultStatus="todo"
        isPending={createMutation.isPending || updateMutation.isPending}
        members={members}
      />

      {/* Template picker */}
      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4" /> Choose a Template
            </DialogTitle>
            <DialogDescription>Select a template to pre-fill the task form.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {templates.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No templates yet.</p>
            ) : templates.map((tpl) => (
              <button
                key={tpl.id}
                className="w-full text-left rounded-lg border p-3 hover:bg-muted/50 transition-colors space-y-1"
                onClick={() => handleSelectTemplate(tpl)}
              >
                <p className="text-sm font-medium">{tpl.name}</p>
                <p className="text-xs text-muted-foreground truncate">{tpl.title}</p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="capitalize">{tpl.priority}</span>
                  {tpl.tags.length > 0 && <span>· {tpl.tags.slice(0,3).map((t) => `#${t}`).join(' ')}</span>}
                  {tpl.checklist.length > 0 && <span>· {tpl.checklist.length} checklist item{tpl.checklist.length !== 1 ? 's' : ''}</span>}
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
