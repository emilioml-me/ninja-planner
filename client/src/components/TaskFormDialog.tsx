import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { safeFromNow } from '@/lib/utils';
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
import { useIsAdmin, useIsViewer } from '@/hooks/use-is-admin';
import { toast } from '@/hooks/use-toast';
import { useMembers, type WorkspaceMember } from '@/hooks/use-members';
import { useTaskComments, useAddComment, useDeleteComment } from '@/hooks/use-notifications';
import { Send, Trash2, MessageSquare, Plus, CheckSquare2, Square, GitBranch, ArrowRight, ArrowLeft, Clock, Eye, EyeOff, Timer, Paperclip, FileText, Download, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CustomFieldsSection } from '@/components/CustomFieldsSection';

interface TaskActivity {
  id: string;
  actor_clerk_id: string;
  action: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

/** Same caps as the server's task schema (tasks.ts). */
const MAX_CHECKLIST_ITEMS = 50;
const MAX_DESCRIPTION = 10000;
/** Server cap for a single time log (time_logs minutes max). */
const MAX_LOG_MINUTES = 14400;

/** crypto.randomUUID only exists in secure contexts (https / localhost), not over plain-http LAN. */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* insecure context */ }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STATUS_TEXT: Record<string, string> = {
  todo: 'To Do', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked',
};

const FIELD_LABELS: Record<string, string> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority',
  due_date: 'due date', start_date: 'start date', tags: 'tags', assignee_clerk_id: 'assignee',
  sprint_id: 'sprint', epic_id: 'epic', recurrence_rule: 'recurrence', story_points: 'story points',
  checklist: 'checklist', position: 'position',
};

/**
 * Human text for one activity row. `payload` holds the fields that were sent/changed; values are
 * shown for short scalar fields, names for the assignee, and long/complex fields by name only.
 */
function formatAction(
  action: string,
  payload: Record<string, unknown> | null,
  nameOf: (clerkId: string) => string,
): string {
  const describe = (key: string, value: unknown): string => {
    const label = FIELD_LABELS[key] ?? key.replace(/_/g, ' ');
    if (value === null || value === undefined || value === '') {
      return `${label} to none`;
    }
    switch (key) {
      case 'status': return `status to ${STATUS_TEXT[String(value)] ?? String(value)}`;
      case 'priority': return `priority to ${String(value)}`;
      case 'assignee_clerk_id': return `assignee to ${nameOf(String(value))}`;
      case 'due_date':
      case 'start_date': return `${label} to ${String(value).slice(0, 10)}`;
      case 'story_points':
      case 'recurrence_rule': return `${label} to ${String(value)}`;
      default: return label;
    }
  };

  switch (action) {
    case 'created': return 'Created this task';
    case 'moved': {
      const status = payload?.status as string | undefined;
      return status ? `Moved to ${STATUS_TEXT[status] ?? status}` : 'Reordered';
    }
    case 'updated': {
      const parts = payload
        ? Object.entries(payload).filter(([k]) => k !== 'position').map(([k, v]) => describe(k, v))
        : [];
      return parts.length > 0 ? `Changed ${parts.join(', ')}` : 'Updated';
    }
    case 'deleted': return 'Deleted';
    default: return action;
  }
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  due_date: string | null;
  start_date?: string | null;
  tags: string[];
  position: number;
  assignee_clerk_id: string | null;
  recurrence_rule?: string | null;
  sprint_id?: string | null;
  epic_id?: string | null;
  story_points?: number | null;
  checklist?: ChecklistItem[];
  created_at?: string;
  updated_at?: string;
}

interface DependencyTask { id: string; dependency_id: string; title: string; status: string; priority: string; }
interface TaskDependencies { blocked_by: DependencyTask[]; blocks: DependencyTask[]; }
interface Epic { id: string; title: string; color: string; status: string; }
interface Sprint { id: string; name: string; status: string; }

// Server bounds (tasks.ts): dates 1900-01-01..2199-12-31, at most 50 tags of 200 chars.
const MIN_DATE = '1900-01-01';
const MAX_DATE = '2199-12-31';
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 200;

const dateInRange = z.string().optional().refine(
  (v) => !v || (/^\d{4}-\d{2}-\d{2}$/.test(v) && v >= MIN_DATE && v <= MAX_DATE),
  { message: 'Date must be between 1900-01-01 and 2199-12-31' },
);

const taskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(MAX_DESCRIPTION, `Description must be at most ${MAX_DESCRIPTION} characters`).optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  due_date: dateInRange,
  tags: z.string().optional().refine(
    (v) => {
      const tags = (v ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      return tags.length <= MAX_TAGS && tags.every((t) => t.length <= MAX_TAG_LENGTH);
    },
    { message: `At most ${MAX_TAGS} tags, each up to ${MAX_TAG_LENGTH} characters` },
  ),
  assignee_clerk_id: z.string().optional(),
  recurrence_rule: z.enum(['daily', 'weekly', 'biweekly', 'monthly', '']).optional(),
  epic_id: z.string().optional(),
  sprint_id: z.string().optional(),
  // Stored as string in the form, converted to int on submit. Previously any non-numeric string
  // ("abc") passed this schema unchecked and was silently coerced to null in handleSubmit's
  // parseInt/isNaN check — the user's typo vanished with no error shown. Validate it here so
  // FormMessage actually surfaces the problem instead.
  story_points: z.string().optional().refine(
    (v) => !v || (/^\d+$/.test(v) && Number(v) <= 144),
    { message: 'Must be a whole number from 0 to 144' },
  ),
  start_date: dateInRange,
});

type TaskFormData = z.infer<typeof taskFormSchema>;

type RecurrenceValue = '' | 'daily' | 'weekly' | 'biweekly' | 'monthly';

function taskToFormValues(task: Task | null, defaultStatus: Task['status']): TaskFormData {
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    status: task?.status ?? defaultStatus,
    priority: task?.priority ?? 'medium',
    due_date: task?.due_date ? task.due_date.substring(0, 10) : '',
    tags: task?.tags?.join(', ') ?? '',
    assignee_clerk_id: task?.assignee_clerk_id ?? '',
    recurrence_rule: (task?.recurrence_rule ?? '') as RecurrenceValue,
    epic_id: task?.epic_id ?? '',
    sprint_id: task?.sprint_id ?? '',
    story_points: task?.story_points != null ? String(task.story_points) : '',
    start_date: task?.start_date ? task.start_date.substring(0, 10) : '',
  };
}

function sameFormValues(a: Partial<TaskFormData>, b: TaskFormData): boolean {
  return (Object.keys(b) as (keyof TaskFormData)[]).every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

function formToPayload(data: TaskFormData, checklist: ChecklistItem[]) {
  const tags = data.tags
    ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const sp = data.story_points ? parseInt(data.story_points, 10) : null;
  return {
    title: data.title,
    description: data.description || '',
    status: data.status,
    priority: data.priority,
    due_date: data.due_date ? data.due_date : null,
    tags,
    assignee_clerk_id: data.assignee_clerk_id || null,
    recurrence_rule: (data.recurrence_rule || null) as Task['recurrence_rule'],
    epic_id: data.epic_id || null,
    sprint_id: data.sprint_id || null,
    story_points: sp != null && !isNaN(sp) ? sp : null,
    start_date: data.start_date ? data.start_date : null,
    checklist,
  } satisfies Partial<Task> & { title: string };
}

interface TaskFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Create mode: the full task (title always present). Edit mode: ONLY the fields the user
   * changed relative to the task the form was seeded from (title present only if changed), so a
   * PATCH never overwrites teammates' concurrent edits to other fields. When nothing changed the
   * dialog closes itself without calling onSubmit.
   */
  onSubmit: (data: Partial<Task>) => void;
  task?: Task | null;
  defaultStatus?: Task['status'];
  isPending?: boolean;
  members?: WorkspaceMember[];
  allTasks?: Task[];
}

// ─── Checklist tab ────────────────────────────────────────────────────────────

function ChecklistTab({
  items,
  onChange,
}: {
  items: ChecklistItem[];
  onChange: (items: ChecklistItem[]) => void;
}) {
  const [newText, setNewText] = useState('');
  const doneCount = items.filter((i) => i.done).length;
  const atCap = items.length >= MAX_CHECKLIST_ITEMS;

  const addItem = () => {
    const text = newText.trim();
    if (!text || atCap) return;
    onChange([...items, { id: newId(), text, done: false }]);
    setNewText('');
  };

  const toggleItem = (id: string) =>
    onChange(items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)));

  const removeItem = (id: string) => onChange(items.filter((i) => i.id !== id));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); addItem(); }
  };

  return (
    <div className="space-y-3">
      {items.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
            <span>{doneCount} of {items.length} done</span>
            <span>{items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0}%</span>
          </div>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all rounded-full"
              style={{ width: `${items.length > 0 ? (doneCount / items.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">No checklist items yet.</p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 group rounded-md px-1 py-1 hover:bg-muted/40"
          >
            <button
              type="button"
              onClick={() => toggleItem(item.id)}
              className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
            >
              {item.done
                ? <CheckSquare2 className="h-4 w-4 text-primary" />
                : <Square className="h-4 w-4" />}
            </button>
            <span className={cn('flex-1 text-sm', item.done && 'line-through text-muted-foreground')}>
              {item.text}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => removeItem(item.id)}
            >
              <Trash2 className="h-3 w-3 text-muted-foreground" />
            </Button>
          </div>
        ))}
      </div>

      <Separator />

      <div className="flex gap-2">
        <Input
          placeholder={atCap ? `Limit of ${MAX_CHECKLIST_ITEMS} items reached` : 'Add an item…'}
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 h-8 text-sm"
          maxLength={500}
          disabled={atCap}
        />
        <Button type="button" size="sm" variant="outline" onClick={addItem} disabled={!newText.trim() || atCap}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}

// ─── Comments tab ─────────────────────────────────────────────────────────────

/**
 * Extract @token mentions from text and match them against member display names.
 * Tokens are unicode-aware (\p{L}/\p{N}, so "@José" works) and must EXACTLY equal one of the
 * name's whitespace-separated parts, or the whole name with spaces removed ("@MariaLopez").
 * Previously a prefix match on any name part meant "@a" mentioned every member whose name had
 * a part starting with "a".
 */
function parseMentions(text: string, members: WorkspaceMember[]): WorkspaceMember[] {
  const words = Array.from(text.matchAll(/@([\p{L}\p{N}_.'-]+)/gu))
    .map((m) => m[1].replace(/[.'-]+$/u, '').toLocaleLowerCase())
    .filter(Boolean);
  if (!words.length) return [];
  return members.filter((m) => {
    const name = m.display_name.trim().toLocaleLowerCase();
    if (!name) return false;
    const parts = name.split(/\s+/u);
    const joined = parts.join('');
    return words.some((w) => w === joined || parts.includes(w));
  });
}

function CommentsTab({ task, members }: { task: Task; members: WorkspaceMember[] }) {
  const { userId } = useAuth();
  const [draft, setDraft] = useState('');
  const { data: comments = [] } = useTaskComments(task.id);
  const { mutate: addComment, isPending: adding } = useAddComment(task.id);
  const { mutate: deleteComment } = useDeleteComment(task.id);

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));

  // Live mention detection
  const mentionedMembers = parseMentions(draft, members.filter((m) => m.clerk_user_id !== userId));

  const handleSend = () => {
    const body = draft.trim();
    if (!body) return;
    const mentions = mentionedMembers.map((m) => m.clerk_user_id);
    addComment({ body, mentions: mentions.length ? mentions : undefined }, { onSuccess: () => setDraft('') });
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
                      {safeFromNow(c.created_at, { addSuffix: true })}
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
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <Textarea
            placeholder="Write a comment… use @name to mention. ⌘Enter to send."
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
        {mentionedMembers.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap px-0.5">
            <span className="text-[10px] text-muted-foreground">Mentioning:</span>
            {mentionedMembers.map((m) => (
              <span key={m.clerk_user_id} className="text-[10px] bg-primary/10 text-primary rounded px-1.5 py-0.5 font-medium">
                @{m.display_name.split(' ')[0]}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Dependencies tab ─────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-slate-100 text-slate-700',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  urgent: 'bg-red-100 text-red-800',
};

const STATUS_COLORS: Record<string, string> = {
  todo: 'text-muted-foreground',
  in_progress: 'text-blue-600',
  done: 'text-green-600 line-through',
  blocked: 'text-red-500',
};

function DependenciesTab({ task, allTasks }: { task: Task; allTasks: Task[] }) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const [addDir, setAddDir] = useState<'blocked_by' | 'blocks' | null>(null);
  const [search, setSearch] = useState('');

  const { data: deps } = useQuery<TaskDependencies>({
    queryKey: ['/api/tasks', task.id, 'dependencies'],
    queryFn: () => apiRequest('GET', `/api/tasks/${task.id}/dependencies`),
  });

  const addMutation = useMutation({
    mutationFn: ({ task_id, direction }: { task_id: string; direction: 'blocked_by' | 'blocks' }) =>
      apiRequest('POST', `/api/tasks/${task.id}/dependencies`, { task_id, direction }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'dependencies'] });
      setAddDir(null);
      setSearch('');
    },
    onError: (err: Error) => toast({ title: 'Failed to add dependency', description: err.message, variant: 'destructive' }),
  });

  const removeMutation = useMutation({
    mutationFn: (dependencyId: string) => apiRequest('DELETE', `/api/tasks/${task.id}/dependencies/${dependencyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'dependencies'] }),
    onError: () => toast({ title: 'Failed to remove dependency', variant: 'destructive' }),
  });

  const blockedByIds  = new Set((deps?.blocked_by ?? []).map((t) => t.id));
  const blocksIds     = new Set((deps?.blocks    ?? []).map((t) => t.id));
  const excludedIds   = new Set([task.id, ...blockedByIds, ...blocksIds]);

  const candidates = allTasks.filter((t) =>
    !excludedIds.has(t.id) &&
    (search === '' || t.title.toLowerCase().includes(search.toLowerCase())),
  ).slice(0, 8);

  const renderDepRow = (t: DependencyTask, direction: 'blocked_by' | 'blocks') => (
    <div key={t.id} className="flex items-center gap-2 py-1 group">
      {direction === 'blocked_by'
        ? <ArrowLeft className="h-3.5 w-3.5 text-red-400 shrink-0" />
        : <ArrowRight className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
      <span className={cn('flex-1 text-sm truncate', STATUS_COLORS[t.status] ?? '')}>{t.title}</span>
      <span className={cn('text-[10px] rounded px-1.5 py-0.5 shrink-0', PRIORITY_COLORS[t.priority] ?? '')}>{t.priority}</span>
      <Button
        type="button" variant="ghost" size="icon"
        className="h-5 w-5 opacity-0 group-hover:opacity-100 shrink-0"
        onClick={() => removeMutation.mutate(t.dependency_id)}
        disabled={removeMutation.isPending}
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Blocked by */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Blocked by ({deps?.blocked_by.length ?? 0})
          </h4>
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs gap-1"
            onClick={() => setAddDir('blocked_by')}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        {deps?.blocked_by.length === 0 && (
          <p className="text-xs text-muted-foreground italic">No blockers — this task can start freely.</p>
        )}
        {deps?.blocked_by.map((t) => renderDepRow(t, 'blocked_by'))}
      </div>

      {/* Blocks */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Blocks ({deps?.blocks.length ?? 0})
          </h4>
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs gap-1"
            onClick={() => setAddDir('blocks')}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        {deps?.blocks.length === 0 && (
          <p className="text-xs text-muted-foreground italic">This task doesn't block any other tasks.</p>
        )}
        {deps?.blocks.map((t) => renderDepRow(t, 'blocks'))}
      </div>

      {/* Add picker */}
      {addDir && (
        <div className="border rounded-md p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground">
            {addDir === 'blocked_by' ? 'Select a task that blocks this one:' : 'Select a task this one blocks:'}
          </p>
          <Input
            placeholder="Search tasks…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
            autoFocus
          />
          <div className="space-y-1 max-h-36 overflow-y-auto">
            {candidates.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">No matching tasks</p>
            )}
            {candidates.map((t) => (
              <button
                key={t.id}
                type="button"
                className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted transition-colors truncate"
                onClick={() => addMutation.mutate({ task_id: t.id, direction: addDir })}
                disabled={addMutation.isPending}
              >
                {t.title}
              </button>
            ))}
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs"
            onClick={() => { setAddDir(null); setSearch(''); }}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Attachments tab ─────────────────────────────────────────────────────────

interface Attachment {
  id: string;
  file_name: string;
  // BIGINT column: arrives as a string.
  file_size: string | number;
  mime_type: string;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
}

// Must match ALLOWED_MIME in src/routes/attachments.ts (SVG is rejected there: stored XSS risk).
const ALLOWED_TYPES = [
  'image/jpeg','image/png','image/gif','image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain','text/csv','text/markdown',
  'application/zip',
  'video/mp4','video/webm',
  'audio/mpeg','audio/wav',
];

/**
 * Browsers often report an empty (or OS-specific) type for .md / .csv / .zip etc. Fall back to
 * the extension so those uploads aren't rejected client-side (the server re-checks the type).
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', markdown: 'text/markdown',
  zip: 'application/zip',
  mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav',
};

function resolveMimeType(file: File): string | null {
  if (ALLOWED_TYPES.includes(file.type)) return file.type;
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  return MIME_BY_EXTENSION[ext] ?? null;
}

function fmtBytes(raw: string | number): string {
  const b = Number(raw) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

function AttachmentsTab({ task }: { task: Task }) {
  const { userId } = useAuth();
  const isAdmin = useIsAdmin();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const { data: attachments = [] } = useQuery<Attachment[]>({
    queryKey: ['/api/tasks', task.id, 'attachments'],
    queryFn: () => apiRequest('GET', `/api/tasks/${task.id}/attachments`),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/tasks/${task.id}/attachments/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'attachments'] }),
    onError: (err: Error) => toast({ title: 'Failed to delete attachment', description: err.message, variant: 'destructive' }),
  });

  const handleDownload = async (att: Attachment) => {
    try {
      const { url } = await apiRequest<{ url: string }>('GET', `/api/tasks/${task.id}/attachments/${att.id}/download`);
      const a = document.createElement('a');
      a.href = url; a.download = att.file_name; a.click();
    } catch {
      toast({ title: 'Failed to download attachment', variant: 'destructive' });
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const resetInput = () => { if (fileRef.current) fileRef.current.value = ''; };
    if (file.size > 50 * 1024 * 1024) { setUploadErr('File too large (max 50 MB)'); resetInput(); return; }
    const mimeType = resolveMimeType(file);
    if (!mimeType) { setUploadErr('File type not allowed'); resetInput(); return; }

    setUploading(true); setUploadErr(null);
    try {
      // Step 1: get presigned upload URL
      const { upload_url, r2_key } = await apiRequest<{ upload_url: string; r2_key: string }>(
        'POST', `/api/tasks/${task.id}/attachments/presign`,
        { file_name: file.name, file_size: file.size, mime_type: mimeType },
      );

      // Step 2: upload directly to R2
      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: file,
      });
      if (!putRes.ok) throw new Error('Upload to storage failed');

      // Step 3: confirm metadata
      await apiRequest('POST', `/api/tasks/${task.id}/attachments`, {
        file_name: file.name, file_size: file.size, mime_type: mimeType, r2_key,
      });
      qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'attachments'] });
    } catch (err) {
      setUploadErr((err as Error).message ?? 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const isImage = (mime: string) => mime.startsWith('image/');

  return (
    <div className="space-y-4">
      {/* Upload area */}
      <div
        className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
        onClick={() => fileRef.current?.click()}
      >
        <Paperclip className="h-6 w-6 mx-auto text-muted-foreground/50 mb-1" />
        <p className="text-xs text-muted-foreground">
          {uploading ? 'Uploading…' : 'Click to attach a file (max 50 MB)'}
        </p>
        {uploadErr && <p className="text-xs text-destructive mt-1">{uploadErr}</p>}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept={[...ALLOWED_TYPES, ...Object.keys(MIME_BY_EXTENSION).map((ext) => `.${ext}`)].join(',')}
          onChange={handleFile}
          disabled={uploading}
        />
      </div>

      {/* List */}
      <div className="space-y-1.5 max-h-52 overflow-y-auto">
        {attachments.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No attachments yet.</p>
        ) : (
          attachments.map((att) => (
            <div key={att.id} className="flex items-center gap-2 group rounded-md px-2 py-1.5 hover:bg-muted/40">
              {isImage(att.mime_type)
                ? <ImageIcon className="h-4 w-4 text-blue-500 shrink-0" />
                : <FileText className="h-4 w-4 text-muted-foreground shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium truncate">{att.file_name}</p>
                <p className="text-[10px] text-muted-foreground">
                  {fmtBytes(att.file_size)} · {att.uploaded_by === userId ? 'you' : (att.uploader_name ?? 'former member')}
                </p>
              </div>
              <Button
                type="button" variant="ghost" size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
                onClick={() => handleDownload(att)}
                title="Download"
              >
                <Download className="h-3 w-3" />
              </Button>
              {(att.uploaded_by === userId || isAdmin) && (
                <Button
                  type="button" variant="ghost" size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
                  title="Delete"
                  disabled={deleteMut.isPending}
                  onClick={() => deleteMut.mutate(att.id)}
                >
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Time tracking tab ───────────────────────────────────────────────────────

interface TimeLog {
  id: string;
  user_clerk_id: string;
  display_name: string | null;
  minutes: number;
  note: string | null;
  billable: boolean;
  // NUMERIC column: arrives as a string. The server may omit/null it for non-admins.
  hourly_rate?: string | number | null;
  budget_entry_id: string | null;
  logged_at: string;
}

/** Admin-only inline editor for a time log's hourly rate (PATCH .../time-logs/:id). */
function RateEditor({
  log, onSave, pending,
}: {
  log: TimeLog;
  onSave: (rate: number | null) => void;
  pending: boolean;
}) {
  const current = log.hourly_rate != null ? String(Number(log.hourly_rate)) : '';
  const [value, setValue] = useState(current);
  useEffect(() => { setValue(current); }, [current]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === current) return;
    if (trimmed === '') { onSave(null); return; }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      toast({ title: 'Hourly rate must be between 0 and 10000', variant: 'destructive' });
      setValue(current);
      return;
    }
    onSave(n);
  };

  return (
    <Input
      type="number" min={0} max={10000} step="0.01" placeholder="Rate"
      title="Hourly rate ($/h)"
      aria-label="Hourly rate"
      value={value}
      disabled={pending}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      className="h-6 w-20 text-[11px] shrink-0"
    />
  );
}

interface BudgetEntryOption {
  id: string;
  description: string;
  budget_id: string;
  budget_name: string;
}

const NO_BUDGET_ENTRY = '__none__';

function TimeTab({ task }: { task: Task }) {
  const { userId } = useAuth();
  const isAdmin = useIsAdmin();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const [hours, setHours]     = useState('');
  const [mins,  setMins]      = useState('');
  const [note,  setNote]      = useState('');
  const [billable, setBillable] = useState(false);
  const [rate, setRate]       = useState('');

  const { data: logs = [] } = useQuery<TimeLog[]>({
    queryKey: ['/api/tasks', task.id, 'time-logs'],
    queryFn: () => apiRequest('GET', `/api/tasks/${task.id}/time-logs`),
  });

  const addMut = useMutation({
    mutationFn: (body: { minutes: number; note?: string; billable?: boolean; hourly_rate?: number | null }) =>
      apiRequest('POST', `/api/tasks/${task.id}/time-logs`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] });
      setHours(''); setMins(''); setNote(''); setBillable(false); setRate('');
    },
    onError: (err: Error) => toast({ title: 'Failed to log time', description: err.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/tasks/${task.id}/time-logs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] }),
    onError: (err: Error) => toast({ title: 'Failed to delete time entry', description: err.message, variant: 'destructive' }),
  });

  const { data: budgetEntries = [] } = useQuery<BudgetEntryOption[]>({
    queryKey: ['/api/budgets/entries'],
    queryFn: () => apiRequest('GET', '/api/budgets/entries'),
  });

  const rateMut = useMutation({
    mutationFn: ({ logId, hourlyRate }: { logId: string; hourlyRate: number | null }) =>
      apiRequest('PATCH', `/api/tasks/${task.id}/time-logs/${logId}`, { hourly_rate: hourlyRate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] });
      // Rates feed budget time_cost and analytics billable totals.
      qc.invalidateQueries({ queryKey: ['/api/budgets'] });
    },
    onError: (err: Error) => toast({ title: 'Failed to update hourly rate', description: err.message, variant: 'destructive' }),
  });

  const linkBudgetMut = useMutation({
    mutationFn: ({ logId, budgetEntryId }: { logId: string; budgetEntryId: string | null }) =>
      apiRequest('PATCH', `/api/tasks/${task.id}/time-logs/${logId}/budget-entry`, { budget_entry_id: budgetEntryId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] }),
    onError: () => toast({ title: 'Failed to link budget entry', variant: 'destructive' }),
  });

  const totalMins = logs.reduce((s, l) => s + l.minutes, 0);
  const fmtTime = (m: number) => {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h}h ${rem > 0 ? `${rem}m` : ''}`.trim() : `${rem}m`;
  };

  // The Input `min`/`max` attributes are advisory only — they don't block a typed or pasted
  // out-of-range value in a React-controlled input. Validate explicitly (instead of silently
  // clamping 300h down to 240h) and use the SAME parsed values for the disabled check and submit.
  const parsedHours = hours.trim() === '' ? 0 : Number(hours);
  const parsedMins  = mins.trim() === '' ? 0 : Number(mins);
  const timeError =
    !Number.isInteger(parsedHours) || parsedHours < 0 || parsedHours > 240
      ? 'Hours must be a whole number from 0 to 240'
      : !Number.isInteger(parsedMins) || parsedMins < 0 || parsedMins > 59
        ? 'Minutes must be a whole number from 0 to 59'
        : null;
  const rawTotal = timeError ? 0 : parsedHours * 60 + parsedMins;
  const capError = !timeError && rawTotal > MAX_LOG_MINUTES
    ? `A single entry can be at most ${MAX_LOG_MINUTES / 60} hours`
    : null;
  const totalEntered = capError ? 0 : rawTotal;

  const handleLog = () => {
    if (timeError || capError) return;
    const total = totalEntered;
    if (total < 1) return;
    // Only admins may set a custom hourly rate (the server 403s a non-null rate from members,
    // who get the default rate).
    const parsedRate = isAdmin && rate ? Math.max(0, Number(rate)) : null;
    addMut.mutate({
      minutes: total,
      note: note.trim() || undefined,
      billable,
      hourly_rate: billable ? parsedRate : null,
    });
  };

  return (
    <div className="space-y-4">
      {/* Total */}
      <div className="flex items-center gap-2 p-3 rounded-md bg-muted/40">
        <Timer className="h-4 w-4 text-primary shrink-0" />
        <span className="text-sm font-medium">Total logged: {totalMins > 0 ? fmtTime(totalMins) : '—'}</span>
      </div>

      {/* Log entry form */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Log time</p>
        <div className="flex gap-2 items-end">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Hours</label>
            <Input
              type="number" min={0} max={240} placeholder="0"
              value={hours} onChange={(e) => setHours(e.target.value)}
              className="w-20 h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Minutes</label>
            <Input
              type="number" min={0} max={59} placeholder="0"
              value={mins} onChange={(e) => setMins(e.target.value)}
              className="w-20 h-8 text-sm"
            />
          </div>
          <Input
            placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)}
            className="flex-1 h-8 text-sm"
            maxLength={500}
          />
          <Button
            type="button" size="sm" onClick={handleLog}
            disabled={addMut.isPending || !!timeError || !!capError || totalEntered < 1}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Log
          </Button>
        </div>
        {(timeError || capError) && <p className="text-xs text-destructive">{timeError ?? capError}</p>}
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox" checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Billable
          </label>
          {billable && isAdmin && (
            <Input
              type="number" min={0} max={10000} step="0.01" placeholder="Hourly rate ($)"
              value={rate} onChange={(e) => setRate(e.target.value)}
              className="w-32 h-7 text-xs"
            />
          )}
        </div>
      </div>

      <Separator />

      {/* History */}
      <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
        {logs.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No time logged yet.</p>
        ) : (
          logs.map((log) => {
            const isOwn = log.user_clerk_id === userId;
            const name  = log.display_name ?? log.user_clerk_id.slice(-6);
            return (
              <div key={log.id} className="flex items-center gap-2 text-sm group rounded-md px-1 py-1 hover:bg-muted/40">
                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium text-xs w-12 shrink-0">{fmtTime(log.minutes)}</span>
                <span className="flex-1 text-xs text-muted-foreground truncate">
                  {log.note || <span className="italic">no note</span>}
                  {' '}· {isOwn ? 'you' : name}
                  {log.billable && (
                    <span className="text-green-600 ml-1">
                      · billable{!isAdmin && log.hourly_rate != null ? ` $${Number(log.hourly_rate)}/h` : ''}
                    </span>
                  )}
                </span>
                {log.billable && isAdmin && (
                  <RateEditor
                    log={log}
                    pending={rateMut.isPending}
                    onSave={(hourlyRate) => rateMut.mutate({ logId: log.id, hourlyRate })}
                  />
                )}
                {log.billable && (isOwn || isAdmin) && (
                  <Select
                    value={log.budget_entry_id ?? NO_BUDGET_ENTRY}
                    onValueChange={(v) => linkBudgetMut.mutate({ logId: log.id, budgetEntryId: v === NO_BUDGET_ENTRY ? null : v })}
                  >
                    <SelectTrigger className="h-6 w-32 text-[11px] shrink-0">
                      <SelectValue placeholder="No budget" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_BUDGET_ENTRY}>No budget entry</SelectItem>
                      {budgetEntries.map((be) => (
                        <SelectItem key={be.id} value={be.id}>{be.budget_name}: {be.description}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {(isOwn || isAdmin) && (
                  <Button
                    type="button" variant="ghost" size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
                    title="Delete"
                    disabled={deleteMut.isPending}
                    onClick={() => deleteMut.mutate(log.id)}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Watchers bar ─────────────────────────────────────────────────────────────

interface Watcher { user_clerk_id: string; display_name: string | null; }

function WatchersBar({ task }: { task: Task }) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();

  const { data: watchers = [] } = useQuery<Watcher[]>({
    queryKey: ['/api/tasks', task.id, 'watchers'],
    queryFn: () => apiRequest('GET', `/api/tasks/${task.id}/watchers`),
  });

  const isWatching = watchers.some((w) => w.user_clerk_id === userId);

  const watchMut = useMutation({
    mutationFn: () => isWatching
      ? apiRequest('DELETE', `/api/tasks/${task.id}/watchers`)
      : apiRequest('POST',   `/api/tasks/${task.id}/watchers`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'watchers'] }),
    onError: (err: Error) => toast({ title: 'Failed to update watch status', description: err.message, variant: 'destructive' }),
  });

  const names = watchers
    .filter((w) => w.user_clerk_id !== userId)
    .map((w) => w.display_name?.split(' ')[0] ?? '…')
    .join(', ');

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Button
        type="button" variant="ghost" size="sm"
        className="h-6 gap-1.5 px-2 text-xs"
        onClick={() => watchMut.mutate()}
        disabled={watchMut.isPending}
      >
        {isWatching
          ? <><EyeOff className="h-3 w-3" /> Unwatch</>
          : <><Eye className="h-3 w-3" /> Watch</>}
      </Button>
      {watchers.length > 0 && (
        <span className="truncate max-w-[200px]">
          {isWatching ? 'You' : ''}
          {isWatching && names ? ', ' : ''}
          {names}
          {' '}watching
        </span>
      )}
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
  allTasks = [],
}: TaskFormDialogProps) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [activeTab, setActiveTab] = useState('details');

  // Load available epics and sprints for the selectors
  const { data: epics = [] } = useQuery<Epic[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
    enabled: open,
  });

  const { data: sprints = [] } = useQuery<Sprint[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
    enabled: open,
  });

  const { data: taskDetail } = useQuery<{ task: Task; activity: TaskActivity[] }>({
    queryKey: ['/api/tasks', task?.id],
    queryFn: () => apiRequest(`GET`, `/api/tasks/${task!.id}`),
    enabled: open && !!task?.id,
  });

  const activity = taskDetail?.activity ?? [];

  const isViewer = useIsViewer();
  const { lookup: memberLookup } = useMembers();
  const memberName = useCallback(
    (clerkId: string) => memberLookup.get(clerkId)?.display_name ?? 'Former member',
    [memberLookup],
  );

  const form = useForm<TaskFormData>({
    resolver: zodResolver(taskFormSchema),
    defaultValues: taskToFormValues(null, defaultStatus),
  });

  // The task the form (and checklist) were last seeded from. Edit-mode PATCHes send only fields
  // that differ from this baseline, so fields the user didn't touch never overwrite teammates'
  // concurrent edits.
  const baselineRef = useRef<Task | null>(null);
  const checklistTouchedRef = useRef(false);

  // Tabs whose panels have been opened at least once in this dialog session. Panels are mounted
  // on first open (so their queries don't all fire up front) and then kept mounted, hidden, so
  // in-progress input (time entry, comment draft, custom fields) survives tab switches.
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set(['details']));
  const changeTab = (tab: string) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  };

  // Custom fields save registered by CustomFieldsSection; awaited inside "Update Task".
  const customSaveRef = useRef<(() => Promise<void>) | null>(null);
  const registerCustomSave = useCallback((save: (() => Promise<void>) | null) => {
    customSaveRef.current = save;
  }, []);
  const [savingCustom, setSavingCustom] = useState(false);

  useEffect(() => {
    if (open) {
      form.reset(taskToFormValues(task ?? null, defaultStatus));
      setChecklist(task?.checklist ?? []);
      baselineRef.current = task ?? null;
      checklistTouchedRef.current = false;
      setActiveTab('details');
      setVisitedTabs(new Set(['details']));
    }
  }, [open, task, defaultStatus, form]);

  // The `task` prop is a list snapshot (up to 30s stale). When the fresh GET /api/tasks/:id
  // result arrives, re-seed from it -- but only while the user hasn't edited anything yet, so
  // their input is never replaced.
  const freshTask = taskDetail?.task;
  useEffect(() => {
    if (!open || !task?.id || !freshTask || freshTask.id !== task.id) return;
    const baseline = baselineRef.current;
    const untouched = !checklistTouchedRef.current
      && sameFormValues(form.getValues(), taskToFormValues(baseline, defaultStatus));
    if (!untouched) return;
    form.reset(taskToFormValues(freshTask, defaultStatus));
    setChecklist(freshTask.checklist ?? []);
    baselineRef.current = freshTask;
  }, [open, task?.id, freshTask, defaultStatus, form]);

  const handleChecklistChange = (items: ChecklistItem[]) => {
    checklistTouchedRef.current = true;
    setChecklist(items);
  };

  const handleSubmit = (data: TaskFormData) => {
    onSubmit(formToPayload(data, checklist));
  };

  const handleEditSubmit = async (data: TaskFormData) => {
    // Custom fields first: if they fail, nothing else is saved and the dialog stays open.
    if (customSaveRef.current) {
      setSavingCustom(true);
      try {
        await customSaveRef.current();
      } catch (err) {
        toast({ title: 'Failed to save custom fields', description: (err as Error).message, variant: 'destructive' });
        changeTab('details');
        return;
      } finally {
        setSavingCustom(false);
      }
    }
    const next = formToPayload(data, checklist);
    const base = formToPayload(taskToFormValues(baselineRef.current, defaultStatus), baselineRef.current?.checklist ?? []);
    const changed: Partial<Task> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (JSON.stringify(next[key]) !== JSON.stringify(base[key])) {
        (changed as Record<string, unknown>)[key] = next[key];
      }
    }
    if (Object.keys(changed).length === 0) {
      onOpenChange(false);
      return;
    }
    onSubmit(changed);
  };

  // The footer "Update Task" button sits outside the details TabsContent, so a `form=` submit
  // did nothing when another tab was active (the <form> isn't mounted then). Submit via
  // react-hook-form directly and jump back to the details tab if validation fails so the
  // field errors are visible.
  const submitEdit = form.handleSubmit(handleEditSubmit, () => changeTab('details'));

  // ── Edit mode: tabbed layout ────────────────────────────────────────────────
  // Keyed on task.id, not the task object: "From template" pre-fills pass a task with id ''
  // which must open the CREATE form (and must not fire per-task requests with an empty id).
  if (task?.id) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[580px] flex flex-col max-h-[90vh]">
          <DialogHeader className="shrink-0">
            <DialogTitle>Edit Task</DialogTitle>
            <DialogDescription>Update the task details or leave a comment.</DialogDescription>
          </DialogHeader>

          <WatchersBar task={task} />

          <Tabs value={activeTab} onValueChange={changeTab} className="mt-1 flex flex-col flex-1 min-h-0">
            <TabsList className="w-full shrink-0">
              <TabsTrigger value="details" className="flex-1">Details</TabsTrigger>
              <TabsTrigger value="checklist" className="flex-1 gap-1.5">
                Checklist
                {checklist.length > 0 && (
                  <span className="text-[10px] bg-primary/15 text-primary rounded px-1 font-medium">
                    {checklist.filter((i) => i.done).length}/{checklist.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="files" className="flex-1">
                <Paperclip className="h-3.5 w-3.5 mr-1" />Files
              </TabsTrigger>
              <TabsTrigger value="time" className="flex-1">
                <Clock className="h-3.5 w-3.5 mr-1" />Time
              </TabsTrigger>
              <TabsTrigger value="deps" className="flex-1">
                <GitBranch className="h-3.5 w-3.5 mr-1" />Deps
              </TabsTrigger>
              <TabsTrigger value="comments" className="flex-1">Comments</TabsTrigger>
              {activity.length > 0 && (
                <TabsTrigger value="activity" className="flex-1">Activity</TabsTrigger>
              )}
            </TabsList>

            <div className="flex-1 overflow-y-auto min-h-0 pr-1">
            {/* ── Details tab ─────────────────────────────────────────────── */}
            {/* forceMount + data-[state=inactive]:hidden on every panel with local input: Radix
                unmounts inactive panels by default (losing drafts), and a force-mounted panel is
                only hidden by this class. Panels other than details mount on first open. */}
            <TabsContent value="details" className="mt-4 data-[state=inactive]:hidden" forceMount>
              <Form {...form}>
                <form id="task-edit-form" onSubmit={(e) => { e.preventDefault(); void submitEdit(); }} className="space-y-4 pb-2">
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
                    <FormField control={form.control} name="start_date" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Start Date</FormLabel>
                        <FormControl><Input type="date" min={MIN_DATE} max={MAX_DATE} {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="due_date" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Due Date</FormLabel>
                        <FormControl><Input type="date" min={MIN_DATE} max={MAX_DATE} {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
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
                        <Select onValueChange={(v) => field.onChange(v === '__unassigned__' ? '' : v)} value={field.value || '__unassigned__'}>
                          <FormControl><SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger></FormControl>
                          <SelectContent>
                            <SelectItem value="__unassigned__">Unassigned</SelectItem>
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
                      <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                        <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          <SelectItem value="daily">Daily</SelectItem>
                          <SelectItem value="weekly">Weekly</SelectItem>
                          <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                          <SelectItem value="monthly">Monthly</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />

                  {(sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').length > 0 ||
                    epics.filter((e) => e.status !== 'archived').length > 0) && (
                    <div className="grid grid-cols-2 gap-4">
                      {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').length > 0 && (
                        <FormField control={form.control} name="sprint_id" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Sprint</FormLabel>
                            <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                              <FormControl><SelectTrigger><SelectValue placeholder="No sprint" /></SelectTrigger></FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">No sprint</SelectItem>
                                {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').map((s) => (
                                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )} />
                      )}

                      {epics.filter((e) => e.status !== 'archived').length > 0 && (
                        <FormField control={form.control} name="epic_id" render={({ field }) => (
                          <FormItem>
                            <FormLabel>Epic</FormLabel>
                            <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                              <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                              <SelectContent>
                                <SelectItem value="__none__">No epic</SelectItem>
                                {epics.filter((e) => e.status !== 'archived').map((e) => (
                                  <SelectItem key={e.id} value={e.id}>
                                    <span className="flex items-center gap-1.5">
                                      <span className="h-2 w-2 rounded-full inline-block" style={{ backgroundColor: e.color }} />
                                      {e.title}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )} />
                      )}
                    </div>
                  )}

                  <FormField control={form.control} name="story_points" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Story Points</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} max={144} placeholder="–" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                </form>
              </Form>

              <CustomFieldsSection entityType="task" entityId={task.id} registerSave={registerCustomSave} />
            </TabsContent>

            {/* ── Checklist tab ────────────────────────────────────────────── */}
            <TabsContent value="checklist" className="mt-4">
              <ChecklistTab items={checklist} onChange={handleChecklistChange} />
            </TabsContent>

            {/* ── Files tab ───────────────────────────────────────────────── */}
            <TabsContent value="files" className="mt-4">
              <AttachmentsTab task={task} />
            </TabsContent>

            {/* ── Time tab ────────────────────────────────────────────────── */}
            <TabsContent value="time" className="mt-4 data-[state=inactive]:hidden" forceMount>
              {visitedTabs.has('time') && <TimeTab task={task} />}
            </TabsContent>

            {/* ── Dependencies tab ─────────────────────────────────────────── */}
            <TabsContent value="deps" className="mt-4 data-[state=inactive]:hidden" forceMount>
              {visitedTabs.has('deps') && <DependenciesTab task={task} allTasks={allTasks} />}
            </TabsContent>

            {/* ── Comments tab ────────────────────────────────────────────── */}
            <TabsContent value="comments" className="mt-4 data-[state=inactive]:hidden" forceMount>
              {visitedTabs.has('comments') && <CommentsTab task={task} members={members} />}
            </TabsContent>

            {/* ── Activity tab ────────────────────────────────────────────── */}
            {activity.length > 0 && (
              <TabsContent value="activity" className="mt-4">
                <div className="space-y-2 pr-1">
                  {[...activity].reverse().map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2 text-xs">
                      <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5 text-[10px] font-medium text-muted-foreground">
                        {entry.actor_clerk_id === userId
                          ? 'Me'
                          : memberName(entry.actor_clerk_id).split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium mr-1">
                          {entry.actor_clerk_id === userId ? 'You' : memberName(entry.actor_clerk_id)}
                        </span>
                        <span className="text-foreground">{formatAction(entry.action, entry.payload, memberName)}</span>
                        <span className="text-muted-foreground ml-1.5">
                          {safeFromNow(entry.created_at, { addSuffix: true }) ? `· ${safeFromNow(entry.created_at, { addSuffix: true })}` : ''}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>
            )}
            </div>{/* end scrollable tab area */}
          </Tabs>

          <DialogFooter className="shrink-0 border-t pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {isViewer ? 'Close' : 'Cancel'}
            </Button>
            {!isViewer && (
              <Button type="button" onClick={() => void submitEdit()} disabled={isPending || savingCustom}>
                {isPending || savingCustom ? 'Saving...' : 'Update Task'}
              </Button>
            )}
          </DialogFooter>
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
              <FormField control={form.control} name="start_date" render={({ field }) => (
                <FormItem>
                  <FormLabel>Start Date</FormLabel>
                  <FormControl><Input type="date" min={MIN_DATE} max={MAX_DATE} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="due_date" render={({ field }) => (
                <FormItem>
                  <FormLabel>Due Date</FormLabel>
                  <FormControl><Input type="date" min={MIN_DATE} max={MAX_DATE} {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField control={form.control} name="tags" render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl><Input placeholder="work, design (comma-sep)" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="story_points" render={({ field }) => (
                <FormItem>
                  <FormLabel>Story Points</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} max={144} placeholder="–" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            {members.length > 0 && (
              <FormField control={form.control} name="assignee_clerk_id" render={({ field }) => (
                <FormItem>
                  <FormLabel>Assignee</FormLabel>
                  <Select onValueChange={(v) => field.onChange(v === '__unassigned__' ? '' : v)} value={field.value || '__unassigned__'}>
                    <FormControl><SelectTrigger><SelectValue placeholder="Unassigned" /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="__unassigned__">Unassigned</SelectItem>
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
                <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                  <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="__none__">None</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            {(sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').length > 0 ||
              epics.filter((e) => e.status !== 'archived').length > 0) && (
              <div className="grid grid-cols-2 gap-4">
                {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').length > 0 && (
                  <FormField control={form.control} name="sprint_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sprint</FormLabel>
                      <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                        <FormControl><SelectTrigger><SelectValue placeholder="No sprint" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">No sprint</SelectItem>
                          {sprints.filter((s) => s.status !== 'completed' && s.status !== 'cancelled').map((s) => (
                            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}

                {epics.filter((e) => e.status !== 'archived').length > 0 && (
                  <FormField control={form.control} name="epic_id" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Epic</FormLabel>
                      <Select onValueChange={(v) => field.onChange(v === '__none__' ? '' : v)} value={(field.value ?? '') || '__none__'}>
                        <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">No epic</SelectItem>
                          {epics.filter((e) => e.status !== 'archived').map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              <span className="flex items-center gap-1.5">
                                <span className="h-2 w-2 rounded-full inline-block" style={{ backgroundColor: e.color }} />
                                {e.title}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}
              </div>
            )}

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
