import { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearch } from 'wouter';
import { isBefore, isToday, startOfDay } from 'date-fns';
import { ApiError, useApiClient } from '@/lib/api';
import { useTaskList } from '@/hooks/use-tasks';
import { useToast } from '@/hooks/use-toast';
import { useMembers } from '@/hooks/use-members';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { KanbanBoard, type KanbanCard, type KanbanColumnData } from '@/components/KanbanBoard';
import { TaskFormDialog, type Task } from '@/components/TaskFormDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Plus, Search, X, LayoutGrid, List, MoreVertical, Pencil, Trash2, Clock, Calendar,
  CheckSquare, ChevronDown, Download, FileText, Upload, AlertTriangle,
} from 'lucide-react';
import { downloadCsv } from '@/lib/export-csv';
import { cn, localDateOnly, safeFormat } from '@/lib/utils';

interface Sprint { id: string; name: string; status: string; }

interface ImportResult {
  imported: number;
  skipped: number;
  validation_errors?: { row: number; error: string }[];
  warnings?: { row: number; warning: string }[];
}

type BulkUpdate = Partial<Pick<Task, 'status' | 'priority' | 'assignee_clerk_id' | 'sprint_id'>>;

/**
 * Runs `fn` over `items` with at most `limit` requests in flight. Used as the fallback for bulk
 * actions -- firing one request per selected task all at once (previously Promise.allSettled over
 * every id) tripped the API rate limiter and locked the user out with 429s.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<T[]> {
  const failed: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch { failed.push(item); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return failed;
}

const BULK_CONCURRENCY = 5;
const BULK_CHUNK = 200;

/** Server row errors are JSON-stringified zod fieldErrors -- render them as "field: msg". */
function formatImportError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (parsed && typeof parsed === 'object') {
      const parts = Object.entries(parsed).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
      if (parts.length > 0) return parts.join('; ');
    }
  } catch { /* plain string */ }
  return raw;
}

interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: Task['priority'];
  tags: string[];
  checklist: { id: string; text: string; done: boolean }[];
}

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
    checklist: task.checklist,
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
  selectedIds,
  onToggleSelect,
  onToggleAll,
  sprintMap = {},
}: {
  tasks: Task[];
  onEdit: (task: Task) => void;
  onDelete?: (id: string) => void;
  displayName: (id: string | null | undefined) => string;
  initials: (id: string | null | undefined) => string;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleAll: (ids: string[]) => void;
  sprintMap?: Record<string, string>;
}) {
  const now = new Date();
  const todayStart = startOfDay(now);

  const sorted = [...tasks].sort((a, b) => {
    const aOverdue = a.due_date && isBefore(new Date(a.due_date + 'T23:59:59'), todayStart) && a.status !== 'done';
    const bOverdue = b.due_date && isBefore(new Date(b.due_date + 'T23:59:59'), todayStart) && b.status !== 'done';
    if (aOverdue && !bOverdue) return -1;
    if (!aOverdue && bOverdue) return 1;
    return a.position - b.position;
  });

  const allSelected = sorted.length > 0 && sorted.every((t) => selectedIds.has(t.id));
  const someSelected = sorted.some((t) => selectedIds.has(t.id));

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
            <TableHead className="w-10">
              <input
                type="checkbox"
                checked={allSelected}
                ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                onChange={() => onToggleAll(sorted.map((t) => t.id))}
                className="rounded border-muted-foreground/30 accent-primary cursor-pointer"
              />
            </TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead>Sprint</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Tags</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((task) => {
            const isOverdue = task.due_date && task.status !== 'done' &&
              isBefore(new Date(task.due_date + 'T23:59:59'), todayStart);
            const dueToday = task.due_date && isToday(localDateOnly(task.due_date));
            const selected = selectedIds.has(task.id);
            return (
              <TableRow
                key={task.id}
                className={cn('cursor-pointer hover:bg-muted/50', selected && 'bg-primary/5')}
                onClick={() => onEdit(task)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onToggleSelect(task.id)}
                    className="rounded border-muted-foreground/30 accent-primary cursor-pointer"
                  />
                </TableCell>
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
                  {task.sprint_id && sprintMap[task.sprint_id]
                    ? <Badge variant="outline" className="text-xs font-normal">{sprintMap[task.sprint_id]}</Badge>
                    : <span className="text-xs text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {task.due_date ? (
                    <span className={cn(
                      'text-xs flex items-center gap-1',
                      isOverdue ? 'text-destructive font-medium' : dueToday ? 'text-yellow-600' : 'text-muted-foreground',
                    )}>
                      {isOverdue ? <Clock className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                      {safeFormat(task.due_date, 'MMM d')}
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
                      {onDelete && (
                        <DropdownMenuItem className="text-destructive" onClick={() => onDelete(task.id)}>
                          <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      )}
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

// ─── Main page ────────────────────────────────────────────────────────────────

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importErrors, setImportErrors] = useState<{ row: number; error: string }[] | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const { tasks, isLoading, truncated, total: totalTasks } = useTaskList();

  const { members, displayName, initials } = useMembers();
  const isAdmin = useIsAdmin();

  const { data: templates = [] } = useQuery<TaskTemplate[]>({
    queryKey: ['/api/task-templates'],
    queryFn: () => apiRequest<TaskTemplate[]>('GET', '/api/task-templates'),
    staleTime: 60_000,
  });

  const { data: sprints = [] } = useQuery<Sprint[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest<Sprint[]>('GET', '/api/sprints'),
    staleTime: 30_000,
  });

  const sprintMap = Object.fromEntries(sprints.map((s) => [s.id, s.name]));

  // Listen for command palette "new task" event
  const openNewTask = useCallback(() => {
    setEditingTask(null);
    setDefaultStatus('todo');
    setDialogOpen(true);
  }, []);

  useEffect(() => {
    window.addEventListener('ninja-planner:new-task', openNewTask);
    return () => window.removeEventListener('ninja-planner:new-task', openNewTask);
  }, [openNewTask]);

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

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: Partial<Task> & { id: string; title: string }) =>
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

  // ─── Bulk actions ─────────────────────────────────────────────────────────

  // POST /api/tasks/bulk: one request per chunk of up to BULK_CHUNK ids (server max 200), same
  // auth rules and per-task side effects as the single-task routes. Ids the server reports as
  // not_found count as failed. If the endpoint is missing (404/405 from an older server), fall
  // back to per-task requests with limited concurrency.
  const runBulk = async (
    ids: string[],
    op: { update: BulkUpdate } | { delete: true },
  ): Promise<{ succeeded: number; failed: string[] }> => {
    const failed: string[] = [];
    let remaining = ids;
    try {
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, BULK_CHUNK);
        const body = 'update' in op
          ? { action: 'update', ids: chunk, changes: op.update }
          : { action: 'delete', ids: chunk };
        const res = await apiRequest<{ not_found?: string[] } | undefined>('POST', '/api/tasks/bulk', body);
        failed.push(...(res?.not_found ?? []));
        remaining = remaining.slice(BULK_CHUNK);
      }
      return { succeeded: ids.length - failed.length, failed };
    } catch (err) {
      const endpointMissing = err instanceof ApiError && (err.status === 404 || err.status === 405)
        && remaining.length === ids.length;
      if (!endpointMissing) {
        // Earlier chunks may have succeeded; everything from the failing chunk on is "failed".
        if (remaining.length < ids.length) {
          failed.push(...remaining);
          return { succeeded: ids.length - failed.length, failed };
        }
        throw err;
      }
    }
    const fallbackFailed = await runWithConcurrency(ids, BULK_CONCURRENCY, (id) =>
      'update' in op
        ? apiRequest('PATCH', `/api/tasks/${id}`, op.update)
        : apiRequest('DELETE', `/api/tasks/${id}`),
    );
    return { succeeded: ids.length - fallbackFailed.length, failed: fallbackFailed };
  };

  const bulkUpdateMutation = useMutation({
    mutationFn: ({ ids, update }: { ids: string[]; update: BulkUpdate }) => runBulk(ids, { update }),
    onSuccess: ({ succeeded, failed }) => {
      // Always refresh -- some tasks may have succeeded even if others failed.
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sprints'] });
      setSelectedIds(new Set(failed));
      if (failed.length === 0) {
        toast({ title: `${succeeded} task${succeeded !== 1 ? 's' : ''} updated` });
      } else if (succeeded === 0) {
        toast({ title: 'Bulk update failed', description: `All ${failed.length} tasks failed to update`, variant: 'destructive' });
      } else {
        toast({
          title: `${succeeded} updated, ${failed.length} failed`,
          description: 'Failed tasks remain selected — try again or check permissions.',
          variant: 'destructive',
        });
      }
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      toast({ title: 'Bulk update failed', description: err.message, variant: 'destructive' });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: (ids: string[]) => runBulk(ids, { delete: true }),
    onSuccess: ({ succeeded, failed }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      setSelectedIds(new Set(failed));
      setBulkDeleteConfirm(false);
      if (failed.length === 0) {
        toast({ title: `${succeeded} task${succeeded !== 1 ? 's' : ''} deleted` });
      } else if (succeeded === 0) {
        toast({ title: 'Bulk delete failed', description: `All ${failed.length} tasks failed to delete`, variant: 'destructive' });
      } else {
        toast({
          title: `${succeeded} deleted, ${failed.length} failed`,
          description: 'Failed tasks remain selected — try again or check permissions.',
          variant: 'destructive',
        });
      }
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      setBulkDeleteConfirm(false);
      toast({ title: 'Bulk delete failed', description: err.message, variant: 'destructive' });
    },
  });

  const importMutation = useMutation({
    mutationFn: (csv: string) => apiRequest<ImportResult>('POST', '/api/tasks/import', { csv }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['/api/tasks'] });
      setImportResult(res);
      setImportErrors(null);
      setImportCsv('');
    },
    onError: (err: Error) => {
      // 422 "All rows failed validation" carries per-row details -- show them instead of only
      // the generic message.
      const details = err instanceof ApiError
        ? (err.body as { details?: { row: number; error: string }[] } | undefined)?.details
        : undefined;
      setImportErrors(Array.isArray(details) && details.length > 0 ? details : null);
      toast({ title: 'Import failed', description: err.message, variant: 'destructive' });
    },
  });

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = (ids: string[]) => {
    const allSelected = ids.every((id) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(ids));
    }
  };

  const clearSelection = () => setSelectedIds(new Set());

  // Open a task named by ?task=<id> (used by the command palette), then strip the param so a
  // refresh / closing the dialog doesn't reopen it.
  const searchString = useSearch();
  const [, navigate] = useLocation();
  const taskParam = new URLSearchParams(searchString).get('task');
  useEffect(() => {
    if (!taskParam || isLoading) return;
    let cancelled = false;
    const openTask = (task: Task) => {
      if (cancelled) return;
      setEditingTask(task);
      setDialogOpen(true);
      navigate('/tasks', { replace: true });
    };
    const found = tasks.find((t) => t.id === taskParam);
    if (found) {
      openTask(found);
    } else {
      // Not in the (possibly truncated) list -- fetch it directly.
      apiRequest<{ task: Task }>('GET', `/api/tasks/${encodeURIComponent(taskParam)}`)
        .then((res) => openTask(res.task))
        .catch(() => {
          if (cancelled) return;
          toast({ title: 'Task not found', variant: 'destructive' });
          navigate('/tasks', { replace: true });
        });
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskParam, isLoading]);

  // ─── Filters ───────────────────────────────────────────────────────────────

  const filteredTasks = useMemo(() => {
    const q = search.toLowerCase().trim();
    return tasks.filter((t) => {
      if (q) {
        const inTitle = t.title.toLowerCase().includes(q);
        const inDesc  = t.description?.toLowerCase().includes(q) ?? false;
        const inTags  = t.tags.some((tag) => tag.toLowerCase().includes(q));
        if (!inTitle && !inDesc && !inTags) return false;
      }
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      return true;
    });
  }, [tasks, search, priorityFilter]);

  // Drop selected ids that are no longer visible (filtered out) or no longer exist (deleted),
  // so bulk actions never act on tasks the user can't see.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filteredTasks.map((t) => t.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredTasks]);

  const columns: KanbanColumnData[] = COLUMNS.map((col) => ({
    id: col.id,
    title: col.title,
    cards: filteredTasks.filter((t) => t.status === col.id).map(taskToCard),
  }));

  // Unfiltered columns -- KanbanBoard computes drag positions against these so reordering while
  // a search/priority filter is active doesn't corrupt positions relative to hidden tasks.
  const allColumns: KanbanColumnData[] = COLUMNS.map((col) => ({
    id: col.id,
    title: col.title,
    cards: tasks.filter((t) => t.status === col.id).map(taskToCard),
  }));

  const pendingDeleteTask = pendingDeleteId ? tasks.find((t) => t.id === pendingDeleteId) : undefined;

  const hasFilters = search !== '' || priorityFilter !== 'all';
  const selectedCount = selectedIds.size;

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
      assignee_clerk_id: null,
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
    setDefaultStatus('todo');
    setDialogOpen(true);
  };

  const handleSubmit = (data: Partial<Task> & { title: string }) => {
    if (editingTask?.id) {
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
              onClick={() => { setView('kanban'); clearSelection(); }}
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
            variant="outline"
            className="gap-2"
            // Column names / tag separator match POST /api/tasks/import so an export can be
            // re-imported as-is (assignee_name and created_at are informational and ignored).
            onClick={() => downloadCsv('tasks.csv', tasks.map((t) => ({
              title: t.title,
              description: t.description ?? '',
              status: t.status,
              priority: t.priority,
              assignee_clerk_id: t.assignee_clerk_id ?? '',
              assignee_name: t.assignee_clerk_id ? displayName(t.assignee_clerk_id) : '',
              due_date: t.due_date ? t.due_date.substring(0, 10) : '',
              tags: t.tags.join(';'),
              created_at: t.created_at ?? '',
            })))}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-2"
            onClick={() => { setImportOpen(true); setImportResult(null); setImportErrors(null); }}
          >
            <Upload className="h-4 w-4" />
            <span className="hidden sm:inline">Import</span>
          </Button>
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

      {truncated && (
        <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b bg-yellow-50 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Showing {tasks.length} of {Math.max(totalTasks, tasks.length)} tasks; the rest are not listed here.
        </div>
      )}

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
            onDeleteCard={isAdmin ? (id) => setPendingDeleteId(id) : undefined}
            members={members}
            allColumns={allColumns}
          />
        ) : (
          <TaskListView
            tasks={filteredTasks}
            onEdit={(task) => { setEditingTask(task); setDialogOpen(true); }}
            onDelete={isAdmin ? (id) => setPendingDeleteId(id) : undefined}
            displayName={displayName}
            initials={initials}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleAll}
            sprintMap={sprintMap}
          />
        )}
      </div>

      {/* Bulk action bar */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-3 px-6 py-3 border-t bg-muted/50 shrink-0">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">{selectedCount} selected</span>
          </div>
          <div className="flex items-center gap-2 ml-2">
            {/* Bulk status change */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 h-8">
                  Move to <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Change status</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMNS.map((col) => (
                  <DropdownMenuItem
                    key={col.id}
                    onClick={() => bulkUpdateMutation.mutate({
                      ids: [...selectedIds],
                      update: { status: col.id },
                    })}
                  >
                    {col.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Bulk assign */}
            {members.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 h-8">
                    Assign to <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Assign member</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => bulkUpdateMutation.mutate({
                      ids: [...selectedIds],
                      update: { assignee_clerk_id: null },
                    })}
                  >
                    Unassigned
                  </DropdownMenuItem>
                  {members.map((m) => (
                    <DropdownMenuItem
                      key={m.clerk_user_id}
                      onClick={() => bulkUpdateMutation.mutate({
                        ids: [...selectedIds],
                        update: { assignee_clerk_id: m.clerk_user_id },
                      })}
                    >
                      {m.display_name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Bulk sprint assign */}
            {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 h-8">
                    Sprint <ChevronDown className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Assign to sprint</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => bulkUpdateMutation.mutate({
                      ids: [...selectedIds],
                      update: { sprint_id: null },
                    })}
                  >
                    No sprint
                  </DropdownMenuItem>
                  {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').map((s) => (
                    <DropdownMenuItem
                      key={s.id}
                      onClick={() => bulkUpdateMutation.mutate({
                        ids: [...selectedIds],
                        update: { sprint_id: s.id },
                      })}
                    >
                      {s.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Bulk delete — admin only */}
            {isAdmin && (
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setBulkDeleteConfirm(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
          <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={clearSelection}>
            <X className="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
        </div>
      )}

      <TaskFormDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingTask(null); }}
        onSubmit={handleSubmit}
        task={editingTask}
        defaultStatus={defaultStatus}
        isPending={createMutation.isPending || updateMutation.isPending}
        members={members}
        allTasks={tasks}
      />

      {/* Single delete confirm */}
      <Dialog open={pendingDeleteId !== null} onOpenChange={(o) => { if (!o) setPendingDeleteId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete task?</DialogTitle>
            <DialogDescription>
              {pendingDeleteTask ? `"${pendingDeleteTask.title}" will be deleted.` : 'This task will be deleted.'}{' '}
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!pendingDeleteId) return;
                deleteMutation.mutate(pendingDeleteId, { onSettled: () => setPendingDeleteId(null) });
              }}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm */}
      <Dialog open={bulkDeleteConfirm} onOpenChange={setBulkDeleteConfirm}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {selectedCount} task{selectedCount !== 1 ? 's' : ''}?</DialogTitle>
            <DialogDescription>
              This will permanently delete the selected tasks. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => bulkDeleteMutation.mutate([...selectedIds])}
              disabled={bulkDeleteMutation.isPending}
            >
              {bulkDeleteMutation.isPending ? 'Deleting…' : `Delete ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* CSV Import */}
      <Dialog open={importOpen} onOpenChange={(o) => { setImportOpen(o); if (!o) { setImportResult(null); setImportErrors(null); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import Tasks from CSV</DialogTitle>
            <DialogDescription>
              Paste CSV text with headers: title, description, status, priority, due_date,
              tags (separated by ;), assignee_clerk_id. A file exported from this page can be
              re-imported as-is.
            </DialogDescription>
          </DialogHeader>
          {importResult ? (
            <div className="space-y-3">
              <div className="text-center py-4">
                <div className="text-2xl font-bold text-green-600">{importResult.imported}</div>
                <div className="text-sm text-muted-foreground">tasks imported</div>
                {importResult.skipped > 0 && (
                  <div className="text-sm text-muted-foreground mt-1">{importResult.skipped} rows skipped</div>
                )}
              </div>
              {(importResult.validation_errors?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">Skipped rows</p>
                  <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
                    {importResult.validation_errors!.map((e) => (
                      <li key={`e${e.row}`}>Row {e.row}: {formatImportError(e.error)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(importResult.warnings?.length ?? 0) > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-yellow-700 dark:text-yellow-400">Warnings</p>
                  <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
                    {importResult.warnings!.map((w) => (
                      <li key={`w${w.row}`}>Row {w.row}: {w.warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Button className="w-full" onClick={() => setImportOpen(false)}>Done</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <textarea
                className="w-full h-48 border rounded p-2 text-sm font-mono resize-none"
                placeholder={'title,status,priority,due_date,tags\nBuild login,todo,high,2026-07-01,auth\nFix bug,in_progress,medium,,'}
                value={importCsv}
                onChange={(e) => setImportCsv(e.target.value)}
              />
              {importErrors && importErrors.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive">No rows were imported:</p>
                  <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
                    {importErrors.map((e) => (
                      <li key={e.row}>Row {e.row}: {formatImportError(e.error)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {(() => {
                const lines = importCsv.split(/\r?\n/).filter((l) => l.trim());
                if (lines.length === 0) return null;
                const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
                const rowCount = Math.max(lines.length - 1, 0);
                const problems: string[] = [];
                if (!header.includes('title')) problems.push('Header row is missing a "title" column');
                if (rowCount === 0) problems.push('No data rows found below the header');
                if (rowCount > 500) problems.push(`${rowCount} rows found — max 500 per import`);
                return problems.length > 0 ? (
                  <p className="text-xs text-destructive">{problems.join('. ')}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">{rowCount} row{rowCount !== 1 ? 's' : ''} ready to import</p>
                );
              })()}
              <DialogFooter>
                <Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button>
                <Button
                  onClick={() => importMutation.mutate(importCsv)}
                  disabled={(() => {
                    if (!importCsv.trim() || importMutation.isPending) return true;
                    const lines = importCsv.split(/\r?\n/).filter((l) => l.trim());
                    if (lines.length < 2) return true;
                    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
                    if (!header.includes('title')) return true;
                    if (lines.length - 1 > 500) return true;
                    return false;
                  })()}
                >
                  Import
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
