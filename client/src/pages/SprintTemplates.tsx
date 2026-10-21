import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { todayLocal, safeFormat } from '@/lib/utils';
import { useMyRole } from '@/hooks/use-is-admin';
import { QueryError } from '@/components/QueryError';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2, Zap, Play, Pencil } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface Template {
  id: string;
  name: string;
  goal: string | null;
  duration_days: number;
  created_at: string;
}

interface UseTemplateForm {
  template: Template;
  onDone: () => void;
}

/** YYYY-MM-DD + n days, computed on the calendar date (no UTC/local shift). */
function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function UseTemplateDialog({ template, onDone }: UseTemplateForm) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  // Local date — toISOString() is UTC and gives tomorrow for evening users west of UTC.
  const today = todayLocal();

  const [name,      setName]      = useState(template.name);
  const [startDate, setStartDate] = useState(today);

  const mutation = useMutation({
    mutationFn: (data: { name: string; start_date: string }) =>
      apiRequest('POST', `/api/sprint-templates/${template.id}/use`, data),
    onSuccess: () => {
      // The Sprints page caches under ['/api/sprints'] (the old ['sprints'] key matched nothing).
      qc.invalidateQueries({ queryKey: ['/api/sprints'] });
      toast({ title: 'Sprint created from template' });
      onDone();
    },
    onError: (err: Error) => toast({ title: 'Failed to create sprint', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Sprint name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={255} className="mt-1" />
      </div>
      <div>
        <label className="text-sm font-medium">Start date</label>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
        {startDate && (
          <p className="text-xs text-muted-foreground mt-1">
            {/* Matches the server: end = start + duration - 1 (a 14-day sprint ends on day 14). */}
            End date: {safeFormat(addDays(startDate, template.duration_days - 1), 'MMM d, yyyy')}
            {' '}({template.duration_days} days)
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={() => mutation.mutate({ name: name.trim(), start_date: startDate })}
          disabled={!name.trim() || name.trim().length > 255 || !startDate || mutation.isPending}>
          Create Sprint
        </Button>
      </div>
    </div>
  );
}

export default function SprintTemplates() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { isAdmin, isLoading: roleLoading } = useMyRole();
  const { toast } = useToast();

  const [creating,  setCreating]  = useState(false);
  const [editing,   setEditing]   = useState<Template | null>(null);
  const [using,     setUsing]     = useState<Template | null>(null);
  const [newName,   setNewName]   = useState('');
  const [newGoal,   setNewGoal]   = useState('');
  // Kept as the raw input string so typing (e.g. clearing to type "21") doesn't snap to 14.
  const [newDays,   setNewDays]   = useState('14');
  const parsedDays = Number(newDays);
  const daysValid = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 90;
  // Mirrors the server schema: name 1-255 (sent trimmed), goal <= 2000.
  const trimmedName = newName.trim();
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 255;
  const goalValid = newGoal.length <= 2000;

  const dialogOpen = creating || !!editing;
  const openCreate = () => { setEditing(null); setNewName(''); setNewGoal(''); setNewDays('14'); setCreating(true); };
  const openEdit = (t: Template) => {
    setCreating(false);
    setNewName(t.name);
    setNewGoal(t.goal ?? '');
    setNewDays(String(t.duration_days));
    setEditing(t);
  };
  const closeDialog = () => { setCreating(false); setEditing(null); };

  // Same key as EpicTemplates' sprint-template picker so edits here refresh it too.
  const { data, isLoading: templatesLoading, isError, error, refetch } = useQuery<Template[]>({
    queryKey: ['/api/sprint-templates'],
    queryFn: () => apiRequest('GET', '/api/sprint-templates'),
  });
  const templates = data ?? [];
  const isLoading = templatesLoading || roleLoading;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/sprint-templates'] });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; goal: string | null; duration_days: number }) =>
      apiRequest('POST', '/api/sprint-templates', data),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewName('');
      setNewGoal('');
      setNewDays('14');
      toast({ title: 'Template created' });
    },
    onError: (err: Error) => toast({ title: 'Failed to create template', description: err.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; goal: string | null; duration_days: number }) =>
      apiRequest('PATCH', `/api/sprint-templates/${editing!.id}`, data),
    onSuccess: () => {
      invalidate();
      closeDialog();
      toast({ title: 'Template updated' });
    },
    onError: (err: Error) => toast({ title: 'Failed to update template', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/sprint-templates/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Template deleted' }); },
    onError: (err: Error) => toast({ title: 'Failed to delete template', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sprint Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">Reusable blueprints to create sprints faster</p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> New Template
          </Button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit Sprint Template' : 'New Sprint Template'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Template name</label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Standard 2-week sprint" maxLength={255} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Default sprint goal (optional)</label>
              <Textarea value={newGoal} onChange={(e) => setNewGoal(e.target.value)}
                placeholder="Focus on…" rows={2} className="mt-1" />
              {!goalValid && (
                <p className="text-xs text-destructive mt-1">Goal must be 2000 characters or fewer.</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Duration (days)</label>
              <Input type="number" min={1} max={90} value={newDays}
                onChange={(e) => setNewDays(e.target.value)} className="mt-1 w-28" />
              {!daysValid && (
                <p className="text-xs text-destructive mt-1">Enter a whole number of days between 1 and 90.</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button onClick={() => {
                const data = {
                  name: trimmedName,
                  // null (not omitted) so clearing the goal on edit actually persists.
                  goal: newGoal.trim() ? newGoal : null,
                  duration_days: parsedDays,
                };
                if (editing) updateMutation.mutate(data);
                else createMutation.mutate(data);
              }} disabled={!nameValid || !goalValid || !daysValid || createMutation.isPending || updateMutation.isPending}>
                {editing ? 'Update Template' : 'Save Template'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!using} onOpenChange={() => setUsing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start sprint from "{using?.name}"</DialogTitle>
          </DialogHeader>
          {using && <UseTemplateDialog template={using} onDone={() => setUsing(null)} />}
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="space-y-3">{[1,2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : templates.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Zap className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No templates yet. Create one to speed up sprint setup.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between">
                  {t.name}
                  <span className="text-sm font-normal text-muted-foreground">{t.duration_days}d</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                {t.goal && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{t.goal}</p>
                )}
                {/* /use is requireAdmin server-side, so the whole action row is admin-only. */}
                {isAdmin && (
                <div className="flex gap-2">
                  <Button size="sm" className="gap-1 flex-1"
                    onClick={() => setUsing(t)}>
                    <Play className="h-3.5 w-3.5" /> Use Template
                  </Button>
                    <>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => { if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id); }}
                        disabled={deleteMutation.isPending}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
