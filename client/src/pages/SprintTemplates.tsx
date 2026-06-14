import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2, Zap, Play } from 'lucide-react';
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

function UseTemplateDialog({ template, onDone }: UseTemplateForm) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = new Date().toISOString().split('T')[0];

  const [name,      setName]      = useState(template.name);
  const [startDate, setStartDate] = useState(today);

  const mutation = useMutation({
    mutationFn: (data: { name: string; start_date: string }) =>
      apiRequest('POST', `/api/sprint-templates/${template.id}/use`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sprints'] });
      toast({ title: 'Sprint created from template' });
      onDone();
    },
    onError: () => toast({ title: 'Failed to create sprint', variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Sprint name</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
      </div>
      <div>
        <label className="text-sm font-medium">Start date</label>
        <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
        <p className="text-xs text-muted-foreground mt-1">
          End date: {(() => {
            const end = new Date(startDate);
            end.setDate(end.getDate() + template.duration_days);
            return end.toLocaleDateString();
          })()}
          {' '}({template.duration_days} days)
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button onClick={() => mutation.mutate({ name, start_date: startDate })}
          disabled={!name.trim() || mutation.isPending}>
          Create Sprint
        </Button>
      </div>
    </div>
  );
}

export default function SprintTemplates() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { toast } = useToast();

  const [creating,  setCreating]  = useState(false);
  const [using,     setUsing]     = useState<Template | null>(null);
  const [newName,   setNewName]   = useState('');
  const [newGoal,   setNewGoal]   = useState('');
  const [newDays,   setNewDays]   = useState(14);

  const { data: templates = [], isLoading } = useQuery<Template[]>({
    queryKey: ['sprint-templates'],
    queryFn: () => apiRequest('GET', '/api/sprint-templates'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['sprint-templates'] });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; goal?: string; duration_days: number }) =>
      apiRequest('POST', '/api/sprint-templates', data),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewName('');
      setNewGoal('');
      setNewDays(14);
      toast({ title: 'Template created' });
    },
    onError: () => toast({ title: 'Failed to create template', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/sprint-templates/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Template deleted' }); },
    onError: () => toast({ title: 'Failed to delete template', variant: 'destructive' }),
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sprint Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">Reusable blueprints to create sprints faster</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreating(true)} className="gap-2">
            <Plus className="h-4 w-4" /> New Template
          </Button>
        )}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Sprint Template</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Template name</label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Standard 2-week sprint" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Default sprint goal (optional)</label>
              <Textarea value={newGoal} onChange={(e) => setNewGoal(e.target.value)}
                placeholder="Focus on…" rows={2} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Duration (days)</label>
              <Input type="number" min={1} max={90} value={newDays}
                onChange={(e) => setNewDays(parseInt(e.target.value) || 14)} className="mt-1 w-28" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={() => createMutation.mutate({
                name: newName,
                ...(newGoal.trim() ? { goal: newGoal } : {}),
                duration_days: newDays,
              })} disabled={!newName.trim() || createMutation.isPending}>
                Save Template
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
                <div className="flex gap-2">
                  <Button size="sm" className="gap-1 flex-1"
                    onClick={() => setUsing(t)}>
                    <Play className="h-3.5 w-3.5" /> Use Template
                  </Button>
                  {isAdmin && (
                    <Button size="sm" variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteMutation.mutate(t.id)}
                      disabled={deleteMutation.isPending}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
