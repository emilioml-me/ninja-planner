import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApiClient } from '@/lib/api';

export interface WorkspaceMember {
  id: string;
  clerk_user_id: string;
  role: string;
}

interface TaskActivity {
  id: string;
  actor_clerk_id: string;
  action: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function formatAction(action: string, payload: Record<string, unknown> | null): string {
  switch (action) {
    case 'created': return 'Created this task';
    case 'moved': {
      const status = payload?.status as string | undefined;
      return status ? `Moved to ${status.replace('_', ' ')}` : 'Moved';
    }
    case 'updated': {
      const keys = payload ? Object.keys(payload).join(', ') : '';
      return keys ? `Updated ${keys}` : 'Updated';
    }
    case 'deleted': return 'Deleted';
    default: return action;
  }
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date: string | null;
  tags: string[];
  position: number;
  assignee_clerk_id: string | null;
}

const taskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  due_date: z.string().optional(),
  tags: z.string().optional(),
  assignee_clerk_id: z.string().optional(),
});

type TaskFormData = z.infer<typeof taskFormSchema>;

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: Partial<Task> & { title: string }) => void;
  task?: Task | null;
  defaultStatus?: Task['status'];
  isPending?: boolean;
  members?: WorkspaceMember[];
}

export function TaskFormDialog({
  open,
  onOpenChange,
  onSubmit,
  task,
  defaultStatus = 'todo',
  isPending,
  members = [],
}: TaskFormDialogProps) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();

  const { data: taskDetail } = useQuery<{ task: Task; activity: TaskActivity[] }>({
    queryKey: ['/api/tasks', task?.id],
    queryFn: () => apiRequest(`GET`, `/api/tasks/${task!.id}`),
    enabled: open && !!task?.id,
  });

  const activity = taskDetail?.activity ?? [];

  const form = useForm<TaskFormData>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: {
      title: '',
      description: '',
      status: defaultStatus,
      priority: 'medium',
      due_date: '',
      tags: '',
      assignee_clerk_id: '',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        title: task?.title ?? '',
        description: task?.description ?? '',
        status: task?.status ?? defaultStatus,
        priority: task?.priority ?? 'medium',
        due_date: task?.due_date ? task.due_date.substring(0, 10) : '',
        tags: task?.tags?.join(', ') ?? '',
        assignee_clerk_id: task?.assignee_clerk_id ?? '',
      });
    }
  }, [open, task, defaultStatus, form]);

  const handleSubmit = (data: TaskFormData) => {
    const tags = data.tags
      ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    onSubmit({
      title: data.title,
      description: data.description || '',
      status: data.status,
      priority: data.priority,
      due_date: data.due_date ? data.due_date : null,
      tags,
      assignee_clerk_id: data.assignee_clerk_id || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{task ? 'Edit Task' : 'Create Task'}</DialogTitle>
          <DialogDescription>
            {task ? 'Update the task details below.' : 'Fill in the details to create a new task.'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="Task title" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Task description (optional)" rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="todo">To Do</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="done">Done</SelectItem>
                        <SelectItem value="blocked">Blocked</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Priority</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select priority" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="urgent">Urgent</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="due_date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Due Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Tags</FormLabel>
                    <FormControl>
                      <Input placeholder="work, design (comma-sep)" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {members.length > 0 && (
              <FormField
                control={form.control}
                name="assignee_clerk_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Assignee</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value ?? ''}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Unassigned" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Unassigned</SelectItem>
                        {members.map((m) => (
                          <SelectItem key={m.clerk_user_id} value={m.clerk_user_id}>
                            {m.clerk_user_id === userId ? 'Me' : m.clerk_user_id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving...' : task ? 'Update Task' : 'Create Task'}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {/* Activity log — edit mode only */}
        {task && activity.length > 0 && (
          <>
            <Separator />
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Activity</p>
              <div className="max-h-40 overflow-y-auto space-y-2 pr-1">
                {[...activity].reverse().map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 text-xs">
                    <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-medium text-muted-foreground">
                      {entry.actor_clerk_id === userId ? 'Me' : entry.actor_clerk_id.slice(-2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-foreground">{formatAction(entry.action, entry.payload)}</span>
                      <span className="text-muted-foreground ml-1.5">
                        · {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
