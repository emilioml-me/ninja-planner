import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Pencil, Trash2, FileText } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Note {
  id: string;
  title: string;
  content: string;
  sprint_id: string | null;
  epic_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface NoteFormProps {
  initial?: Partial<Note>;
  onSave: (data: { title: string; content: string }) => void;
  onCancel: () => void;
  loading?: boolean;
}

function NoteForm({ initial, onSave, onCancel, loading }: NoteFormProps) {
  const [title,   setTitle]   = useState(initial?.title   ?? '');
  const [content, setContent] = useState(initial?.content ?? '');

  return (
    <div className="space-y-3">
      <Input
        placeholder="Meeting title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={255}
      />
      <Textarea
        placeholder="Notes, decisions, action items…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={10}
        className="font-mono text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={() => onSave({ title, content })} disabled={!title.trim() || loading}>
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
  const { toast } = useToast();

  const [creating,  setCreating]  = useState(false);
  const [editing,   setEditing]   = useState<Note | null>(null);
  const [viewing,   setViewing]   = useState<Note | null>(null);

  const { data: notes = [], isLoading } = useQuery<Note[]>({
    queryKey: ['meeting-notes'],
    queryFn: () => apiRequest('GET', '/api/meeting-notes'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['meeting-notes'] });

  const createMutation = useMutation({
    mutationFn: (data: { title: string; content: string }) =>
      apiRequest('POST', '/api/meeting-notes', data),
    onSuccess: () => { invalidate(); setCreating(false); toast({ title: 'Note created' }); },
    onError: () => toast({ title: 'Failed to create note', variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title: string; content: string } }) =>
      apiRequest('PATCH', `/api/meeting-notes/${id}`, data),
    onSuccess: () => { invalidate(); setEditing(null); toast({ title: 'Note updated' }); },
    onError: () => toast({ title: 'Failed to update note', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/meeting-notes/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Note deleted' }); },
    onError: () => toast({ title: 'Failed to delete note', variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Meeting Notes</h1>
          <p className="text-muted-foreground text-sm mt-1">Notes attached to sprints, epics, or standalone</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Note
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>New Meeting Note</DialogTitle></DialogHeader>
          <NoteForm
            onSave={(data) => createMutation.mutate(data)}
            onCancel={() => setCreating(false)}
            loading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Edit Note</DialogTitle></DialogHeader>
          {editing && (
            <NoteForm
              initial={editing}
              onSave={(data) => updateMutation.mutate({ id: editing.id, data })}
              onCancel={() => setEditing(null)}
              loading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* View dialog */}
      <Dialog open={!!viewing} onOpenChange={() => setViewing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>{viewing?.title}</DialogTitle></DialogHeader>
          <pre className="whitespace-pre-wrap text-sm font-mono bg-muted rounded p-4 max-h-96 overflow-y-auto">
            {viewing?.content || '(no content)'}
          </pre>
          <div className="text-xs text-muted-foreground">
            {viewing && new Date(viewing.updated_at).toLocaleString()}
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
          No meeting notes yet. Create one to get started.
        </div>
      ) : (
        <div className="space-y-3">
          {notes.map((note) => (
            <Card key={note.id} className="cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => setViewing(note)}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{note.title}</CardTitle>
                  <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <Button size="icon" variant="ghost" className="h-7 w-7"
                      onClick={() => setEditing(note)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {isAdmin && (
                      <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate(note.id)}
                        disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {note.content || '(no content)'}
                </p>
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(note.updated_at).toLocaleDateString()}
                  </span>
                  {note.sprint_id && <Badge variant="secondary" className="text-xs">Sprint</Badge>}
                  {note.epic_id   && <Badge variant="secondary" className="text-xs">Epic</Badge>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
