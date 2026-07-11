import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@clerk/clerk-react';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Layers, Plus, MoreVertical, Pencil, Trash2, CheckCircle2, Download, MessageSquare, Send, Sparkles, ClipboardCheck, ExternalLink } from 'lucide-react';
import { downloadCsv } from '@/lib/export-csv';
import { cn, safeFromNow, externalRefLabel } from '@/lib/utils';

interface EpicComment {
  id: string;
  epic_id: string;
  author_clerk_id: string;
  body: string;
  created_at: string;
}

function EpicAiSummary({ epicId }: { epicId: string }) {
  const { apiRequest } = useApiClient();
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true); setError(null); setSummary(null);
    try {
      const res = await apiRequest<{ summary: string }>('POST', `/api/epics/${epicId}/ai-summary`);
      setSummary(res.summary);
    } catch (e) {
      setError((e as Error).message ?? 'AI service unavailable');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t pt-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 uppercase tracking-wide">
          <Sparkles className="h-3.5 w-3.5 text-primary" /> AI Summary
        </p>
        <Button type="button" variant="ghost" size="sm" className="h-6 text-xs gap-1"
          onClick={generate} disabled={loading}>
          {loading ? 'Generating…' : summary ? 'Regenerate' : 'Generate'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {summary && (
        <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{summary}</p>
      )}
      {!summary && !loading && (
        <p className="text-xs text-muted-foreground italic">
          Click Generate to get an AI analysis of this epic's health.
        </p>
      )}
    </div>
  );
}

interface EpicRetroData {
  id: string;
  epic_id: string;
  went_well: string | null;
  to_improve: string | null;
  action_items: string | null;
}

const epicRetroSchema = z.object({
  went_well:    z.string().optional(),
  to_improve:   z.string().optional(),
  action_items: z.string().optional(),
});
type EpicRetroForm = z.infer<typeof epicRetroSchema>;

function EpicRetro({ epicId, isAdmin }: { epicId: string; isAdmin: boolean }) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);

  const { data: retro } = useQuery<EpicRetroData | null>({
    queryKey: ['/api/epics', epicId, 'retro'],
    queryFn: () => apiRequest('GET', `/api/epics/${epicId}/retro`),
  });

  const form = useForm<EpicRetroForm>({
    resolver: zodResolver(epicRetroSchema),
    defaultValues: { went_well: '', to_improve: '', action_items: '' },
  });

  const saveMut = useMutation({
    mutationFn: (data: EpicRetroForm) => apiRequest('PUT', `/api/epics/${epicId}/retro`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/epics', epicId, 'retro'] });
      setEditing(false);
      toast({ title: 'Retrospective saved' });
    },
    onError: () => toast({ title: 'Failed to save retro', variant: 'destructive' }),
  });

  const openEdit = () => {
    form.reset({
      went_well:    retro?.went_well    ?? '',
      to_improve:   retro?.to_improve   ?? '',
      action_items: retro?.action_items ?? '',
    });
    setEditing(true);
  };

  const hasContent = retro && (retro.went_well || retro.to_improve || retro.action_items);

  if (!hasContent && !isAdmin) return null;

  return (
    <div className="border-t pt-3 mt-1">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 uppercase tracking-wide">
          <ClipboardCheck className="h-3.5 w-3.5" /> Retrospective
        </p>
        {isAdmin && !editing && (
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" onClick={openEdit}>
            {hasContent ? 'Edit' : '+ Write retro'}
          </Button>
        )}
      </div>

      {editing ? (
        <Form {...form}>
          <form onSubmit={form.handleSubmit((d) => saveMut.mutate(d))} className="space-y-3">
            <FormField control={form.control} name="went_well" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">✅ What went well</FormLabel>
                <FormControl><Textarea rows={2} className="text-sm resize-none" {...field} /></FormControl>
              </FormItem>
            )} />
            <FormField control={form.control} name="to_improve" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">🔧 What to improve</FormLabel>
                <FormControl><Textarea rows={2} className="text-sm resize-none" {...field} /></FormControl>
              </FormItem>
            )} />
            <FormField control={form.control} name="action_items" render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">🎯 Action items</FormLabel>
                <FormControl><Textarea rows={2} className="text-sm resize-none" {...field} /></FormControl>
              </FormItem>
            )} />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={saveMut.isPending}>
                {saveMut.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        </Form>
      ) : hasContent ? (
        <div className="space-y-2 text-sm">
          {retro.went_well && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">✅ What went well</p>
              <p className="text-muted-foreground whitespace-pre-wrap text-xs">{retro.went_well}</p>
            </div>
          )}
          {retro.to_improve && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">🔧 What to improve</p>
              <p className="text-muted-foreground whitespace-pre-wrap text-xs">{retro.to_improve}</p>
            </div>
          )}
          {retro.action_items && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">🎯 Action items</p>
              <p className="text-muted-foreground whitespace-pre-wrap text-xs">{retro.action_items}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">No retrospective yet.</p>
      )}
    </div>
  );
}

function EpicComments({ epicId }: { epicId: string }) {
  const { userId } = useAuth();
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState('');

  const { data: comments = [] } = useQuery<EpicComment[]>({
    queryKey: ['/api/epics', epicId, 'comments'],
    queryFn: () => apiRequest<EpicComment[]>('GET', `/api/epics/${epicId}/comments`),
  });

  const addMut = useMutation({
    mutationFn: (body: string) => apiRequest('POST', `/api/epics/${epicId}/comments`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/epics', epicId, 'comments'] });
      setDraft('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (commentId: string) => apiRequest('DELETE', `/api/epics/${epicId}/comments/${commentId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/epics', epicId, 'comments'] }),
  });

  const handleSend = () => {
    const body = draft.trim();
    if (!body) return;
    addMut.mutate(body);
  };

  return (
    <div className="space-y-3">
      <Separator />
      <p className="text-sm font-medium flex items-center gap-1.5">
        <MessageSquare className="h-3.5 w-3.5" /> Comments
      </p>
      <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
        {comments.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-3">No comments yet. Be the first!</p>
        ) : (
          comments.map((c) => {
            const isOwn = c.author_clerk_id === userId;
            const initials = c.author_clerk_id.slice(-2).toUpperCase();
            return (
              <div key={c.id} className="flex items-start gap-2 group">
                <Avatar className="h-6 w-6 shrink-0 mt-0.5">
                  <AvatarFallback className="text-[9px] bg-muted">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0 bg-muted/40 rounded-lg px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium">{isOwn ? 'You' : `User ${initials}`}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {safeFromNow(c.created_at, { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{c.body}</p>
                </div>
                {isOwn && (
                  <Button
                    variant="ghost" size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5"
                    onClick={() => deleteMut.mutate(c.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="flex gap-2">
        <Textarea
          placeholder="Add a comment…" rows={2} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="text-sm"
        />
        <Button size="icon" className="shrink-0" disabled={addMut.isPending || !draft.trim()} onClick={handleSend}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

interface Epic {
  id: string;
  title: string;
  description: string | null;
  status: string;
  color: string;
  external_ref: string | null;
  created_by: string;
  total_tasks: number;
  done_tasks: number;
  total_points: number;
  done_points: number;
}

const STATUS_META: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  active:    { label: 'Active',    variant: 'default'   },
  completed: { label: 'Completed', variant: 'secondary' },
  archived:  { label: 'Archived',  variant: 'outline'   },
};

const PRESET_COLORS = [
  '#6366f1', '#f59e0b', '#10b981', '#3b82f6',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
];

// Mirrors Roadmap.tsx's httpUrlSchema — z.string().url() alone accepts javascript: URIs.
const httpUrlSchema = z.string().max(500).refine(
  (v) => { try { return ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; } },
  { message: 'Must be a valid http(s) URL' },
);

const formSchema = z.object({
  title:        z.string().min(1, 'Required').max(500),
  description:  z.string().optional(),
  status:       z.enum(['active', 'completed', 'archived']),
  color:        z.string().regex(/^#[0-9a-fA-F]{6}$/),
  external_ref: httpUrlSchema.or(z.literal('')).optional(),
});
type FormData = z.infer<typeof formSchema>;

function EpicFormDialog({
  open, onOpenChange, epic, onSave, isPending, isAdmin,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  epic?: Epic | null;
  onSave: (data: FormData) => void;
  isPending?: boolean;
  isAdmin?: boolean;
}) {
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title:       epic?.title ?? '',
      description: epic?.description ?? '',
      status:      (epic?.status ?? 'active') as FormData['status'],
      color:       epic?.color ?? '#6366f1',
    },
  });

  // Reset when opening. This dialog instance is reused across different epics (only `open`
  // and `epic` change), so a useState initializer here would only ever run once on first
  // mount — this must be a real effect that re-runs on every reopen, or editing epic B after
  // closing epic A's edit dialog would show A's stale values and silently overwrite B on save.
  useEffect(() => {
    if (open) form.reset({
      title:        epic?.title ?? '',
      description:  epic?.description ?? '',
      status:       (epic?.status ?? 'active') as FormData['status'],
      color:        epic?.color ?? '#6366f1',
      external_ref: epic?.external_ref ?? '',
    });
  }, [open, epic, form]);

  const color = form.watch('color');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{epic ? 'Edit Epic' : 'Create Epic'}</DialogTitle>
          <DialogDescription>Epics group related tasks under a single initiative.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="space-y-4">
            <FormField control={form.control} name="title" render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl><Input placeholder="Epic title" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl><Textarea placeholder="Optional description" rows={2} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />

            <FormField control={form.control} name="external_ref" render={({ field }) => (
              <FormItem>
                <FormLabel>External Link</FormLabel>
                <FormControl><Input placeholder="https://github.com/org/repo/issues/1" {...field} /></FormControl>
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
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                      <SelectItem value="archived">Archived</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

              <FormField control={form.control} name="color" render={({ field }) => (
                <FormItem>
                  <FormLabel>Color</FormLabel>
                  <FormControl>
                    <div className="flex gap-1.5 flex-wrap pt-1">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => field.onChange(c)}
                          className={cn(
                            'h-6 w-6 rounded-full border-2 transition-all',
                            color === c ? 'border-foreground scale-110' : 'border-transparent',
                          )}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? 'Saving…' : epic ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </Form>

        {/* Comments only make sense once the epic exists (mirrors task comments requiring a
            real task id — there's nothing to attach a comment to before the first save). */}
        {epic && (
          <>
            <EpicAiSummary epicId={epic.id} />
            <EpicRetro epicId={epic.id} isAdmin={!!isAdmin} />
            <EpicComments epicId={epic.id} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Epics() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Epic | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Epic | null>(null);

  const { data: epics = [], isLoading } = useQuery<Epic[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/epics'] });

  const createMutation = useMutation({
    mutationFn: (data: FormData) => apiRequest('POST', '/api/epics', data),
    onSuccess: () => { invalidate(); setOpen(false); toast({ title: 'Epic created' }); },
    onError:   () => toast({ title: 'Failed to create epic', variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: FormData) => apiRequest('PATCH', `/api/epics/${editing!.id}`, data),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: 'Epic updated' }); },
    onError:   () => toast({ title: 'Failed to update epic', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/epics/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast({ title: 'Epic deleted' }); },
    onError:   () => toast({ title: 'Failed to delete epic', variant: 'destructive' }),
  });

  const active    = epics.filter((e) => e.status === 'active');
  const completed = epics.filter((e) => e.status === 'completed');
  const archived  = epics.filter((e) => e.status === 'archived');

  const renderGroup = (items: Epic[], label: string) => {
    if (items.length === 0) return null;
    return (
      <section key={label} className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-0.5">{label}</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((epic) => {
            const pct = epic.total_tasks > 0
              ? Math.round((epic.done_tasks / epic.total_tasks) * 100)
              : 0;
            const { label: statusLabel, variant } = STATUS_META[epic.status] ?? STATUS_META.active;
            return (
              <Card key={epic.id} className="relative overflow-hidden">
                {/* Color stripe */}
                <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: epic.color }} />
                <CardHeader className="pt-4 pb-2 flex flex-row items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Layers className="h-4 w-4 shrink-0" style={{ color: epic.color }} />
                    <h3 className="font-semibold text-sm leading-tight truncate">{epic.title}</h3>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant={variant} className="text-[10px] px-1.5">{statusLabel}</Badge>
                    {isAdmin && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-6 w-6">
                            <MoreVertical className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditing(epic)}>
                            <Pencil className="h-3.5 w-3.5 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(epic)}
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-3">
                  {epic.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{epic.description}</p>
                  )}
                  {epic.external_ref && (
                    <a
                      href={epic.external_ref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {externalRefLabel(epic.external_ref)}
                    </a>
                  )}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{epic.done_tasks} / {epic.total_tasks} tasks</span>
                      {epic.total_points > 0 && (
                        <span>{epic.done_points} / {epic.total_points} pts</span>
                      )}
                      <span className="font-medium text-foreground">{pct}%</span>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" /> Epics
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Large initiatives that group related tasks and sprints.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm" variant="outline" className="gap-1.5"
            onClick={() => downloadCsv('epics.csv', epics.map((e) => ({
              title: e.title,
              status: e.status,
              total_tasks: e.total_tasks,
              done_tasks: e.done_tasks,
              total_points: e.total_points,
              done_points: e.done_points,
            })))}
          >
            <Download className="h-4 w-4" />
            <span className="hidden sm:inline">Export</span>
          </Button>
          {isAdmin && (
            <Button onClick={() => setOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> New Epic
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(4)].map((_, i) => (
            <Card key={i}><CardContent className="pt-4"><Skeleton className="h-24 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : epics.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Layers className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No epics yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create an epic to group related tasks under a single initiative.
          </p>
          {isAdmin && (
            <Button className="mt-4 gap-1.5" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> Create your first epic
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-8">
          {renderGroup(active, 'Active')}
          {renderGroup(completed, 'Completed')}
          {renderGroup(archived, 'Archived')}
        </div>
      )}

      {/* Create dialog */}
      <EpicFormDialog
        open={open}
        onOpenChange={setOpen}
        onSave={(d) => createMutation.mutate(d)}
        isPending={createMutation.isPending}
      />

      {/* Edit dialog */}
      <EpicFormDialog
        open={!!editing}
        onOpenChange={(v) => { if (!v) setEditing(null); }}
        epic={editing}
        onSave={(d) => updateMutation.mutate(d)}
        isPending={updateMutation.isPending}
        isAdmin={isAdmin}
      />

      {/* Delete confirm */}
      <Dialog open={!!deleteTarget} onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-[380px]">
          <DialogHeader>
            <DialogTitle>Delete epic?</DialogTitle>
            <DialogDescription>
              <strong>"{deleteTarget?.title}"</strong> will be removed. Tasks assigned to this epic
              will become unassigned. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
