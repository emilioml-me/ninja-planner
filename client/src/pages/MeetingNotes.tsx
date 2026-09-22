import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useMembers } from '@/hooks/use-members';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Pencil, Trash2, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Note {
  id: string;
  title: string;
  content: string;
  /** Set on list rows fetched with ?preview=1 when `content` is only an excerpt. */
  content_truncated?: boolean;
  sprint_id: string | null;
  epic_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface NotePayload {
  title: string;
  content: string;
  sprint_id: string | null;
  epic_id: string | null;
}

// Radix Select can't use '' as an item value.
const NONE = '__none__';

interface NoteFormProps {
  initial?: Partial<Note>;
  sprints: { id: string; name: string }[];
  epics: { id: string; title: string }[];
  onSave: (data: NotePayload) => void;
  onCancel: () => void;
  loading?: boolean;
}

function NoteForm({ initial, sprints, epics, onSave, onCancel, loading }: NoteFormProps) {
  const [title,    setTitle]    = useState(initial?.title   ?? '');
  const [content,  setContent]  = useState(initial?.content ?? '');
  const [sprintId, setSprintId] = useState(initial?.sprint_id ?? NONE);
  const [epicId,   setEpicId]   = useState(initial?.epic_id ?? NONE);

  return (
    <div className="space-y-3">
      <Input
        placeholder="Meeting title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={255}
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Sprint</label>
          <Select value={sprintId} onValueChange={setSprintId}>
            <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {sprints.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Epic</label>
          <Select value={epicId} onValueChange={setEpicId}>
            <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {epics.map((e) => <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Textarea
        placeholder="Notes, decisions, action items…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={10}
        maxLength={50000}
        className="font-mono text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          onClick={() => onSave({
            title,
            content,
            sprint_id: sprintId === NONE ? null : sprintId,
            epic_id:   epicId === NONE ? null : epicId,
          })}
          disabled={!title.trim() || loading}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export default function MeetingNotes() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { userId } = useAuth();
  const { lookup, displayName } = useMembers();
  const { toast } = useToast();

  // Viewers are read-only server-side (requireWorkspace rejects their writes).
  const isViewer = !!userId && lookup.get(userId)?.role === 'viewer';
  // Server rule (PATCH + DELETE): only the author or a workspace admin may modify a note.
  const canModify = (note: Note) => !isViewer && (isAdmin || note.created_by === userId);

  const [creating,  setCreating]  = useState(false);
  const [editing,   setEditing]   = useState<Note | null>(null);
  const [viewing,   setViewing]   = useState<Note | null>(null);

  // preview=1: list rows carry a content excerpt only; the full note is fetched on open.
  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ['meeting-notes'],
    queryFn: () => apiRequest('GET', '/api/meeting-notes?preview=1'),
  });

  const { data: sprints = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
  });
  const { data: epics = [] } = useQuery<{ id: string; title: string }[]>({
    queryKey: ['/api/epics'],
    queryFn: () => apiRequest('GET', '/api/epics'),
  });
  const sprintName = (id: string | null) => (id ? sprints.find((s) => s.id === id)?.name : undefined);
  const epicTitle = (id: string | null) => (id ? epics.find((e) => e.id === id)?.title : undefined);

  // Full note for the open view/edit dialog (list content may be truncated).
  const openId = viewing?.id ?? editing?.id ?? null;
  const openNeedsFull = !!(viewing?.content_truncated || editing?.content_truncated);
  const { data: fullNote, isLoading: fullLoading } = useQuery<Note>({
    queryKey: ['meeting-notes', openId],
    queryFn: () => apiRequest('GET', `/api/meeting-notes/${openId}`),
    enabled: !!openId && openNeedsFull,
  });
  const resolved = (n: Note | null): Note | null =>
    n && n.content_truncated ? (fullNote && fullNote.id === n.id ? fullNote : null) : n;
  const viewingFull = resolved(viewing);
  const editingFull = resolved(editing);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['meeting-notes'] });

  const createMutation = useMutation({
    mutationFn: (data: NotePayload) =>
      apiRequest('POST', '/api/meeting-notes', data),
    onSuccess: () => { invalidate(); setCreating(false); toast({ title: 'Note created' }); },
    onError: (err: Error) => toast({ title: 'Failed to create note', description: err.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: NotePayload }) =>
      apiRequest('PATCH', `/api/meeting-notes/${id}`, data),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: 'Note updated' }); },
    onError: (err: Error) => toast({ title: 'Failed to update note', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/meeting-notes/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Note deleted' }); },
    onError: (err: Error) => toast({ title: 'Failed to delete note', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Meeting Notes</h1>
          <p className="text-muted-foreground text-sm mt-1">Notes attached to sprints, epics, or standalone</p>
        </div>
        {!isViewer && (
          <Button onClick={() => setCreating(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New Note
          </Button>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>New Meeting Note</DialogTitle></DialogHeader>
          {creating && (
            <NoteForm
              sprints={sprints}
              epics={epics}
              onSave={(data) => createMutation.mutate(data)}
              onCancel={() => setCreating(false)}
              loading={createMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit Note</DialogTitle></DialogHeader>
          {editing && !editingFull ? (
            fullLoading ? <Skeleton className="h-64 w-full" /> : <p className="text-sm text-destructive">Failed to load the full note.</p>
          ) : editingFull && (
            <NoteForm
              key={editingFull.id}
              initial={editingFull}
              sprints={sprints}
              epics={epics}
              onSave={(data) => updateMutation.mutate({ id: editingFull.id, data })}
              onCancel={() => setEditing(null)}
              loading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewing} onOpenChange={(v) => { if (!v) setViewing(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{viewing?.title}</DialogTitle></DialogHeader>
          {viewing && !viewingFull ? (
            fullLoading ? <Skeleton className="h-64 w-full" /> : <p className="text-sm text-destructive">Failed to load the full note.</p>
          ) : (
            <pre className="whitespace-pre-wrap text-sm font-mono bg-muted rounded p-4 max-h-96 overflow-y-auto">
              {viewingFull?.content || '(no content)'}
            </pre>
          )}
          <div className="text-xs text-muted-foreground">
            {viewing && `${displayName(viewing.created_by)} · ${new Date(viewing.updated_at).toLocaleString()}`}
          </div>
        </DialogContent>
      </Dialog>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <FileText className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No meeting notes yet.{!isViewer && ' Create one to get started.'}
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <Card key={note.id} className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => setViewing(note)}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{note.title}</CardTitle>
                  {canModify(note) && (
                    <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Button size="icon" variant="ghost" className="h-7 w-7"
                        onClick={() => setEditing(note)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => { if (confirm(`Delete note "${note.title}"?`)) deleteMutation.mutate(note.id); }}
                        disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {note.content || '(no content)'}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-muted-foreground">
                    {displayName(note.created_by)} · {new Date(note.updated_at).toLocaleDateString()}
                  </span>
                  {note.sprint_id && <Badge variant="secondary" className="text-xs">{sprintName(note.sprint_id) ?? 'Sprint'}</Badge>}
                  {note.epic_id   && <Badge variant="secondary" className="text-xs">{epicTitle(note.epic_id) ?? 'Epic'}</Badge>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
