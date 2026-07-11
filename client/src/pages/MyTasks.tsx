import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isBefore, isToday, startOfDay, addDays, isAfter } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useMembers } from '@/hooks/use-members';
import { TaskFormDialog, type Task } from '@/components/TaskFormDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Clock, Calendar, CheckCircle2, AlertCircle, Inbox, Plus, FileText } from 'lucide-react';
import { cn, localDateOnly, safeFormat } from '@/lib/utils';

interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: Task['priority'];
  tags: string[];
  checklist: { id: string; text: string; done: boolean }[];
}

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

function GroupSection({ group }: { group: TaskGroup }) {
  if (group.tasks.length === 0) return null;
  const Icon = group.icon;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={cn('h-4 w-4', group.iconClass)} />
        <h2 className="text-sm font-semibold">{group.label}</h2>
        <span className="text-xs text-muted-foreground">({group.tasks.length})</span>
      </div>
      <div className="space-y-2 pl-6">
        {group.tasks.map((task) => (
          // TaskCard onClick handled by parent
          <TaskCard key={task.id} task={task} onClick={() => {}} />
        ))}
      </div>
    </section>
  );
}

export default function MyTasks() {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { members } = useMembers();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => apiRequest<Task[]>('GET', '/api/tasks'),
  });

  const { data: templates = [] } = useQuery<TaskTemplate[]>({
    queryKey: ['/api/task-templates'],
    queryFn: () => apiRequest<TaskTemplate[]>('GET', '/api/task-templates'),
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

  const openTask = (task: Task) => {
    setEditingTask(task);
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

  const myTasks = tasks.filter(
    (t) => t.assignee_clerk_id === userId && t.status !== 'done',
  );

  const todayStart = startOfDay(new Date());
  const in7Days = addDays(todayStart, 7);

  const overdue = myTasks.filter(
    (t) => t.due_date && isBefore(new Date(t.due_date + 'T23:59:59'), todayStart),
  );
  const dueToday = myTasks.filter(
    (t) => t.due_date && isToday(localDateOnly(t.due_date)),
  );
  const upcoming = myTasks.filter(
    (t) =>
      t.due_date &&
      isAfter(localDateOnly(t.due_date), todayStart) &&
      !isToday(localDateOnly(t.due_date)) &&
      isBefore(localDateOnly(t.due_date), in7Days),
  );
  const later = myTasks.filter(
    (t) =>
      !t.due_date ||
      isAfter(localDateOnly(t.due_date), in7Days),
  );

  const groups: TaskGroup[] = [
    { label: 'Overdue',     icon: Clock,     iconClass: 'text-destructive',  tasks: overdue  },
    { label: 'Due Today',   icon: AlertCircle, iconClass: 'text-yellow-500', tasks: dueToday },
    { label: 'This Week',   icon: Calendar,  iconClass: 'text-blue-500',     tasks: upcoming },
    { label: 'Later',       icon: Inbox,     iconClass: 'text-muted-foreground', tasks: later },
  ];

  const handleSubmit = (data: Partial<Task> & { title: string }) => {
    // editingTask?.id (not just editingTask) — the template picker sets editingTask to a
    // draft object with id: '' to pre-fill the create form, which must still create, not update.
    if (editingTask?.id) {
      updateMutation.mutate({ ...data, id: editingTask.id });
    } else {
      createMutation.mutate({ ...data, assignee_clerk_id: userId ?? null });
    }
  };

  const totalActive = myTasks.length;
  const doneCount = tasks.filter((t) => t.assignee_clerk_id === userId && t.status === 'done').length;

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
          {templates.length > 0 && (
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
          <Button
            size="sm"
            className="gap-2"
            onClick={() => { setEditingTask(null); setDialogOpen(true); }}
          >
            <Plus className="h-4 w-4" />
            New Task
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
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
            <p className="text-xs text-muted-foreground">Create a task or ask a teammate to assign one.</p>
            <Button size="sm" className="mt-2 gap-2" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" /> Create task
            </Button>
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
