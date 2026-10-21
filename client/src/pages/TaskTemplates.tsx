import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useMyRole } from '@/hooks/use-is-admin';
import { useToast } from '@/hooks/use-toast';
import { QueryError } from '@/components/QueryError';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileText, Pencil, Plus, Trash2, X } from 'lucide-react';

type Priority = 'low' | 'medium' | 'high' | 'urgent';

interface ChecklistItem { id: string; text: string; done: boolean; }

interface TaskTemplate {
  id: string;
  name: string;
  title: string;
  description: string | null;
  priority: Priority;
  tags: string[];
  checklist: ChecklistItem[];
  created_at: string;
  updated_at: string;
}

// Same limits as src/routes/taskTemplates.ts.
const MAX_NAME = 200;
const MAX_TITLE = 500;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_CHECKLIST = 50;
const MAX_CHECKLIST_TEXT = 500;

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

/** crypto.randomUUID only exists in secure contexts (https / localhost). */
function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try { return crypto.randomUUID(); } catch { /* insecure context */ }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface Draft {
  name: string;
  title: string;
  description: string;
  priority: Priority;
  tags: string;
  checklist: ChecklistItem[];
}

const EMPTY_DRAFT: Draft = { name: '', title: '', description: '', priority: 'medium', tags: '', checklist: [] };

function toDraft(t: TaskTemplate): Draft {
  return {
    name: t.name,
    title: t.title,
    description: t.description ?? '',
    priority: t.priority,
    tags: t.tags.join(', '),
    checklist: t.checklist.map((i) => ({ ...i, done: false })),
  };
}

function validate(d: Draft): string | null {
  if (!d.name.trim()) return 'Name is required';
  if (d.name.trim().length > MAX_NAME) return `Name must be at most ${MAX_NAME} characters`;
  if (!d.title.trim()) return 'Task title is required';
  if (d.title.trim().length > MAX_TITLE) return `Task title must be at most ${MAX_TITLE} characters`;
  const tags = d.tags.split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length > MAX_TAGS) return `At most ${MAX_TAGS} tags`;
  if (tags.some((t) => t.length > MAX_TAG_LENGTH)) return `Each tag must be at most ${MAX_TAG_LENGTH} characters`;
  if (d.checklist.length > MAX_CHECKLIST) return `At most ${MAX_CHECKLIST} checklist items`;
  return null;
}

function toBody(d: Draft) {
  return {
    name: d.name.trim(),
    title: d.title.trim(),
    description: d.description.trim(),
    priority: d.priority,
    tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
    checklist: d.checklist.map((i) => ({ id: i.id, text: i.text.trim(), done: false })).filter((i) => i.text),
  };
}

export default function TaskTemplates() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAdmin, isLoading: roleLoading } = useMyRole();
  const canManage = !roleLoading && isAdmin;

  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [newItem, setNewItem] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TaskTemplate | null>(null);

  const { data: templates = [], isLoading, isError, error, refetch } = useQuery<TaskTemplate[]>({
    queryKey: ['/api/task-templates'],
    queryFn: () => apiRequest<TaskTemplate[]>('GET', '/api/task-templates'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/task-templates'] });

  const saveMut = useMutation({
    mutationFn: (d: Draft) => editing
      ? apiRequest<TaskTemplate>('PATCH', `/api/task-templates/${editing.id}`, toBody(d))
      : apiRequest<TaskTemplate>('POST', '/api/task-templates', toBody(d)),
    onSuccess: () => {
      invalidate();
      toast({ title: editing ? 'Template updated' : 'Template created' });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: 'Failed to save template', description: err.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/task-templates/${id}`),
    onSuccess: () => {
      invalidate();
      // Epic templates reference task templates by id.
      qc.invalidateQueries({ queryKey: ['/api/epic-templates'] });
      toast({ title: 'Template deleted' });
      setPendingDelete(null);
    },
    onError: (err: Error) => toast({ title: 'Failed to delete template', description: err.message, variant: 'destructive' }),
  });

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setNewItem('');
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (t: TaskTemplate) => {
    setEditing(t);
    setDraft(toDraft(t));
    setNewItem('');
    setFormError(null);
    setDialogOpen(true);
  };

  const addItem = () => {
    const text = newItem.trim();
    if (!text || draft.checklist.length >= MAX_CHECKLIST) return;
    setDraft((d) => ({ ...d, checklist: [...d.checklist, { id: newId(), text, done: false }] }));
    setNewItem('');
  };

  const submit = () => {
    const problem = validate(draft);
    setFormError(problem);
    if (problem) return;
    saveMut.mutate(draft);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Task Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Reusable task presets for "From Template" on the Tasks page and for epic templates.
          </p>
        </div>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> New Template
          </Button>
        )}
      </div>

      {isError && !templates.length ? (
        <QueryError error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full rounded-lg" />)}
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <FileText className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-sm font-medium">No task templates yet</p>
          <p className="text-xs text-muted-foreground">
            {canManage ? 'Create one to pre-fill new tasks.' : 'An admin can create templates here.'}
          </p>
          {canManage && (
            <Button size="sm" className="mt-2 gap-2" onClick={openCreate}>
              <Plus className="h-4 w-4" /> New Template
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base break-words">{t.name}</CardTitle>
                  {canManage && (
                    <div className="flex gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" title="Delete" onClick={() => setPendingDelete(t)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground break-words">{t.title}</p>
                {t.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2 whitespace-pre-wrap">{t.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline" className="capitalize">{t.priority}</Badge>
                  {t.tags.slice(0, 4).map((tag) => (
                    <Badge key={tag} variant="secondary">#{tag}</Badge>
                  ))}
                  {t.tags.length > 4 && <span className="text-muted-foreground">+{t.tags.length - 4}</span>}
                  {t.checklist.length > 0 && (
                    <span className="text-muted-foreground">
                      {t.checklist.length} checklist item{t.checklist.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!saveMut.isPending) setDialogOpen(o); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Template' : 'New Template'}</DialogTitle>
            <DialogDescription>Tasks created from this template start with these values.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="tt-name">Template name</Label>
              <Input id="tt-name" maxLength={MAX_NAME} value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tt-title">Task title</Label>
              <Input id="tt-title" maxLength={MAX_TITLE} value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="tt-desc">Description</Label>
              <Textarea id="tt-desc" rows={3} maxLength={10000} value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Priority</Label>
                <Select value={draft.priority} onValueChange={(v) => setDraft((d) => ({ ...d, priority: v as Priority }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="tt-tags">Tags</Label>
                <Input id="tt-tags" placeholder="work, design (comma-sep)" value={draft.tags}
                  onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Checklist ({draft.checklist.length}/{MAX_CHECKLIST})</Label>
              {draft.checklist.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <Input className="h-8 text-sm" maxLength={MAX_CHECKLIST_TEXT} value={item.text}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      checklist: d.checklist.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i)),
                    }))} />
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Remove"
                    onClick={() => setDraft((d) => ({ ...d, checklist: d.checklist.filter((i) => i.id !== item.id) }))}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Input className="h-8 text-sm" placeholder="Add an item" maxLength={MAX_CHECKLIST_TEXT}
                  value={newItem} disabled={draft.checklist.length >= MAX_CHECKLIST}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addItem(); } }} />
                <Button type="button" size="sm" variant="outline" onClick={addItem}
                  disabled={!newItem.trim() || draft.checklist.length >= MAX_CHECKLIST}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add
                </Button>
              </div>
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saveMut.isPending}>Cancel</Button>
            <Button onClick={submit} disabled={saveMut.isPending}>
              {saveMut.isPending ? 'Saving...' : editing ? 'Save Changes' : 'Create Template'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete template?</DialogTitle>
            <DialogDescription>
              {pendingDelete ? `"${pendingDelete.name}" will be deleted. ` : ''}
              Existing tasks are not affected; epic templates that include it will no longer create that task.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMut.isPending}
              onClick={() => { if (pendingDelete) deleteMut.mutate(pendingDelete.id); }}
            >
              {deleteMut.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
