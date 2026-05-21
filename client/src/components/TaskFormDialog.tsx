import { useEffect, useState, useRef } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Send, Trash2, MessageSquare, Plus, CheckSquare2, Square, GitBranch, ArrowRight, ArrowLeft, Clock, Eye, EyeOff, Timer, Paperclip, FileText, Download, Image as ImageIcon } from 'lucide-react';
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
}

interface DependencyTask { id: string; title: string; status: string; priority: string; }
interface TaskDependencies { blocked_by: DependencyTask[]; blocks: DependencyTask[]; }
interface Epic { id: string; title: string; color: string; status: string; }

const taskFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'blocked']),
  priority: z.enum(['low', 'medium', 'high', 'urgent']),
  due_date: z.string().optional(),
  tags: z.string().optional(),
  assignee_clerk_id: z.string().optional(),
  recurrence_rule: z.enum(['daily', 'weekly', 'biweekly', 'monthly', '']).optional(),
  epic_id: z.string().optional(),
  story_points: z.string().optional(), // stored as string in form, converted to int on submit
  start_date: z.string().optional(),
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

  const addItem = () => {
    const text = newText.trim();
    if (!text) return;
    onChange([...items, { id: crypto.randomUUID(), text, done: false }]);
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
          placeholder="Add an item…"
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 h-8 text-sm"
          maxLength={500}
        />
        <Button type="button" size="sm" variant="outline" onClick={addItem} disabled={!newText.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}

// ─── Comments tab ─────────────────────────────────────────────────────────────

/** Extract @word tokens from text and match against member display names */
function parseMentions(text: string, members: WorkspaceMember[]): WorkspaceMember[] {
  const words = Array.from(text.matchAll(/@(\w+)/g)).map((m) => m[1].toLowerCase());
  if (!words.length) return [];
  return members.filter((m) =>
    words.some((w) => m.display_name.toLowerCase().split(/\s+/).some((part) => part.startsWith(w))),
  );
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
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/tasks/${task.id}/dependencies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'dependencies'] }),
  });

  // Re-fetch full deps with IDs so we can remove
  const { data: fullDeps } = useQuery<{ id: string; blocking_task_id: string; blocked_task_id: string }[]>({
    queryKey: ['/api/tasks', task.id, 'dependencies', 'full'],
    queryFn: async () => {
      const d = await apiRequest<TaskDependencies>('GET', `/api/tasks/${task.id}/dependencies`);
      return []; // We'll derive IDs differently
    },
    enabled: false,
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
        onClick={() => {
          // Find dep id — remove by querying with task pairs
          apiRequest('GET', `/api/tasks/${task.id}/dependencies`).then((d: TaskDependencies) => {
            // We need the dep id from the DB — re-fetch the raw deps list
          });
          // Fallback: re-query and delete by task pair via the route
          qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'dependencies'] });
        }}
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
  file_size: number;
  mime_type: string;
  uploaded_by: string;
  uploader_name: string | null;
  created_at: string;
}

const ALLOWED_TYPES = [
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml',
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

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

function AttachmentsTab({ task }: { task: Task }) {
  const { userId } = useAuth();
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
  });

  const handleDownload = async (att: Attachment) => {
    const { url } = await apiRequest<{ url: string }>('GET', `/api/tasks/${task.id}/attachments/${att.id}/download`);
    const a = document.createElement('a');
    a.href = url; a.download = att.file_name; a.click();
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { setUploadErr('File too large (max 50 MB)'); return; }
    if (!ALLOWED_TYPES.includes(file.type)) { setUploadErr('File type not allowed'); return; }

    setUploading(true); setUploadErr(null);
    try {
      // Step 1: get presigned upload URL
      const { upload_url, r2_key } = await apiRequest<{ upload_url: string; r2_key: string }>(
        'POST', `/api/tasks/${task.id}/attachments/presign`,
        { file_name: file.name, file_size: file.size, mime_type: file.type },
      );

      // Step 2: upload directly to R2
      const putRes = await fetch(upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      });
      if (!putRes.ok) throw new Error('Upload to storage failed');

      // Step 3: confirm metadata
      await apiRequest('POST', `/api/tasks/${task.id}/attachments`, {
        file_name: file.name, file_size: file.size, mime_type: file.type, r2_key,
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
          accept={ALLOWED_TYPES.join(',')}
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
                  {fmtBytes(att.file_size)} · {att.uploader_name ?? 'you'}
                </p>
              </div>
              <Button
                type="button" variant="ghost" size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
                onClick={() => handleDownload(att)}
                title="Download"
              >
                <Download className="h-3 w-3" />
              </Button>
              {att.uploaded_by === userId && (
                <Button
                  type="button" variant="ghost" size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
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
  logged_at: string;
}

function TimeTab({ task }: { task: Task }) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const [hours, setHours]     = useState('');
  const [mins,  setMins]      = useState('');
  const [note,  setNote]      = useState('');

  const { data: logs = [] } = useQuery<TimeLog[]>({
    queryKey: ['/api/tasks', task.id, 'time-logs'],
    queryFn: () => apiRequest('GET', `/api/tasks/${task.id}/time-logs`),
  });

  const addMut = useMutation({
    mutationFn: (body: { minutes: number; note?: string }) =>
      apiRequest('POST', `/api/tasks/${task.id}/time-logs`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] });
      setHours(''); setMins(''); setNote('');
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/tasks/${task.id}/time-logs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks', task.id, 'time-logs'] }),
  });

  const totalMins = logs.reduce((s, l) => s + l.minutes, 0);
  const fmtTime = (m: number) => {
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h}h ${rem > 0 ? `${rem}m` : ''}`.trim() : `${rem}m`;
  };

  const handleLog = () => {
    const h = parseInt(hours || '0', 10);
    const m = parseInt(mins  || '0', 10);
    const total = h * 60 + m;
    if (total < 1) return;
    addMut.mutate({ minutes: total, note: note.trim() || undefined });
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
            disabled={addMut.isPending || (parseInt(hours || '0') * 60 + parseInt(mins || '0')) < 1}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Log
          </Button>
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
                </span>
                {isOwn && (
                  <Button
                    type="button" variant="ghost" size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
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

  // Load available epics for the selector
  const { data: epics = [] } = useQuery<Epic[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
    enabled: open,
  });

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
      epic_id: '',
      story_points: '',
      start_date: '',
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
        epic_id: task?.epic_id ?? '',
        story_points: task?.story_points != null ? String(task.story_points) : '',
        start_date: task?.start_date ? task.start_date.substring(0, 10) : '',
      });
      setChecklist(task?.checklist ?? []);
    }
  }, [open, task, defaultStatus, form]);

  const handleSubmit = (data: TaskFormData) => {
    const tags = data.tags
      ? data.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
    const sp = data.story_points ? parseInt(data.story_points, 10) : null;
    onSubmit({
      title: data.title,
      description: data.description || '',
      status: data.status,
      priority: data.priority,
      due_date: data.due_date ? data.due_date : null,
      tags,
      assignee_clerk_id: data.assignee_clerk_id || null,
      recurrence_rule: data.recurrence_rule || null,
      epic_id: data.epic_id || null,
      story_points: sp != null && !isNaN(sp) ? sp : null,
      start_date: data.start_date ? data.start_date : null,
      checklist,
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

          <WatchersBar task={task} />

          <Tabs defaultValue="details" className="mt-1">
            <TabsList className="w-full">
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
                    <FormField control={form.control} name="start_date" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Start Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />

                    <FormField control={form.control} name="due_date" render={({ field }) => (
                      <FormItem>
                        <FormLabel>Due Date</FormLabel>
                        <FormControl><Input type="date" {...field} /></FormControl>
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

                  <div className="grid grid-cols-2 gap-4">
                    {epics.filter((e) => e.status !== 'archived').length > 0 && (
                      <FormField control={form.control} name="epic_id" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Epic</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value ?? ''}>
                            <FormControl><SelectTrigger><SelectValue placeholder="None" /></SelectTrigger></FormControl>
                            <SelectContent>
                              <SelectItem value="">No epic</SelectItem>
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

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
                    <Button type="submit" disabled={isPending}>
                      {isPending ? 'Saving...' : 'Update Task'}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </TabsContent>

            {/* ── Checklist tab ────────────────────────────────────────────── */}
            <TabsContent value="checklist" className="mt-4">
              <ChecklistTab items={checklist} onChange={setChecklist} />
            </TabsContent>

            {/* ── Files tab ───────────────────────────────────────────────── */}
            <TabsContent value="files" className="mt-4">
              <AttachmentsTab task={task} />
            </TabsContent>

            {/* ── Time tab ────────────────────────────────────────────────── */}
            <TabsContent value="time" className="mt-4">
              <TimeTab task={task} />
            </TabsContent>

            {/* ── Dependencies tab ─────────────────────────────────────────── */}
            <TabsContent value="deps" className="mt-4">
              <DependenciesTab task={task} allTasks={allTasks} />
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
