import { useEffect, useState } from 'react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApiClient } from '@/lib/api';
import { type WorkspaceMember } from '@/hooks/use-members';
import { useTaskComments, useAddComment, useDeleteComment } from '@/hooks/use-notifications';
import { Send, Trash2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';

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
  recurrence_rule?: string | null;
  sprint_id?: string | null;
}

const taskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  due_date: z.string().optional(),
  tags: z.string().optional(),
  assignee_clerk_id: z.string().optional(),
  recurrence_rule: z.enum(['daily', 'weekly', 'biweekly', 'monthly', '']).optional(),
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

// ─── Comments tab ─────────────────────────────────────────────────────────────

function CommentsTab({ task, members }: { task: Task; members: WorkspaceMember[] }) {
  const { userId } = useAuth();
  const [draft, setDraft] = useState('');
  const { data: comments = [] } = useTaskComments(task.id);
  const { mutate: addComment, isPending: adding } = useAddComment(task.id);
  const { mutate: deleteComment } = useDeleteComment(task.id);

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));

  const handleSend = () => {
    const body = draft.trim();
    if (!body) return;
    addComment(body, { onSuccess: () => setDraft('') });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Comment list */}
      <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
        {comments.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <MessageSquare className="h-7 w-7 text-muted-foreground/30 mb-1.5" />
            <p className="text-xs text-muted-foreground">No comments yet. Be the first!</p>
          </div>
        ) : (
          comments.map((c) => {
            const member = memberMap[c.author_clerk_id];
            const name = member?.display_name ?? c.author_clerk_id.slice(-6);
            const initials = name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
            const isOwn = c.author_clerk_id === userId;

            return (
              <div key={c.id} className="flex items-start gap-2 group">
                <Avatar className="h-6 w-6 shrink-0 mt-0.5">
                  <AvatarFallback className="text-[9px] bg-muted">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0 bg-muted/40 rounded-lg px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium">{isOwn ? 'You' : name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
                </div>
                {isOwn && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5"
                    onClick={() => deleteComment(c.id)}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* New comment input */}
      <div className="flex gap-2">
        <Textarea
          placeholder="Write a comment… (⌘Enter to send)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="flex-1 resize-none text-sm"
          maxLength={5000}
        />
        <Button
          size="icon"
          className="shrink-0 self-end"
          onClick={handleSend}
          disabled={!draft.trim() || adding}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Main dialog ──────────────────────────────────────────────────────────────

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
      recurrence_rule: '',
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
        recurrence_rule: (task?.recurrence_rule ?? '') as '' | 'daily' | 'weekly' | 'biweekly' | 'monthly',
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
      recurrence_rule: data.recurrence_rule || null,
    });
  };

  // ── Edit mode: tabbed layout ────────────────────────────────────────────────
  if (task) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[580px]">
          <DialogHeader>
            <DialogTitle>Edit Task</DialogTitle>
            <DialogDescription>Update the task details or leave a comment.</DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="details" className="mt-1">
            <TabsList className="w-full">
              <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
              <TabsTrigger value="comments" className="flex-1">Comments</TabsTrigger>
              {activity.length > 0 && (
                <TabsTrigger value="activity" className="flex-1">Activity</TabsTrigger>
              )}
            </TabsList>

            {/* ── Details tab ─────────────────────────────────────────────── */}
            <TabsContent value="details" className="mt-4">
              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                  <FormField control={form.control} name="title" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl><Input placeholder="Task title" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="description" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Description</FormLabel>
                      <FormControl><Textarea placeholder="Task description (optional)" rows={3} {...field} /></FormControl>
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
                            <SelectItem value="todo">To Do</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="done">Done</SelectItem>
                            <SelectItem value="blocked">Blocked</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="priority" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Priority</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="low">Low</SelectItem>
                            <SelectItem value="medium">Medium</SelectItem>
                            <SelectItem value="high">High</SelectItem>
                            <SelectItem value="urgent">Urgent</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField control={form.control} name="due_date" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Due Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="tags" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tags</FormLabel>
                        <FormControl><Input placeholder="work, design (comma-sep)" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  {members.length > 0 && (
                    <FormField control={form.control} name="assignee_clerk_id" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Assignee</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? ''}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="">Unassigned</SelectItem>
                            {members.map((m) => (
                              <SelectItem key={m.clerk_user_id} value={m.clerk_user_id}>
                                {m.clerk_user_id === userId ? `${m.display_name} (me)` : m.display_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )} />
                  )}

                  <FormField control={form.control} name="recurrence_rule" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Recurrence</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? ''}>
                        <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="">None</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="submit" disabled={isPending}>
                      {isPending ? 'Saving...' : 'Update Task'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </TabsContent>

            {/* ── Comments tab ────────────────────────────────────────────── */}
            <TabsContent value="comments" className="mt-4">
              <CommentsTab task={task} members={members} />
            </TabsContent>

            {/* ── Activity tab ────────────────────────────────────────────── */}
            {activity.length > 0 && (
              <TabsContent value="activity" className="mt-4">
                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
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
              </TabsContent>
            )}
          </Tabs>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Create mode: simple form, no tabs ──────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
          <DialogDescription>Fill in the details to create a new task.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl><Input placeholder="Task title" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl><Textarea placeholder="Task description (optional)" rows={3} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select status" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="todo">To Do</SelectItem>
                      <SelectItem value="in_progress">In Progress</SelectItem>
                      <SelectItem value="done">Done</SelectItem>
                      <SelectItem value="blocked">Blocked</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="priority" render={({ field }) => (
                <FormItem>
                  <FormLabel>Priority</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Select priority" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="medium">Medium</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="due_date" render={({ field }) => (
                <FormItem>
                  <FormLabel>Due Date</FormLabel>
                  <FormControl><Input type="date" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="tags" render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl><Input placeholder="work, design (comma-sep)" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {members.length > 0 && (
              <FormField control={form.control} name="assignee_clerk_id" render={({ field }) => (
                <FormItem>
                  <FormLabel>Assignee</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? ''}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="">Unassigned</SelectItem>
                      {members.map((m) => (
                        <SelectItem key={m.clerk_user_id} value={m.clerk_user_id}>
                          {m.clerk_user_id === userId ? `${m.display_name} (me)` : m.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />
            )}

            <FormField control={form.control} name="recurrence_rule" render={({ field }) => (
              <FormItem>
                <FormLabel>Recurrence</FormLabel>
                <Select onValueChange={field.onChange} value={field.value ?? ''}>
                  <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving...' : 'Create Task'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
