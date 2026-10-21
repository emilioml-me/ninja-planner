import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { todayLocal } from '@/lib/utils';
import { useMyRole } from '@/hooks/use-is-admin';
import { QueryError } from '@/components/QueryError';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Layers, Play, Pencil } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const NO_SPRINT_TEMPLATE = '__none__';

interface TaskTemplate {
  id: string;
  name: string;
  title: string;
}

interface SprintTemplate {
  id: string;
  name: string;
  duration_days: number;
}

interface EpicTemplate {
  id: string;
  name: string;
  epic_title: string;
  epic_description: string | null;
  epic_color: string;
  sprint_template_id: string | null;
  task_template_ids: string[];
  created_at: string;
}

interface FormState {
  name: string;
  epic_title: string;
  epic_description: string;
  epic_color: string;
  sprint_template_id: string;
  task_template_ids: string[];
}

const EMPTY_FORM: FormState = {
  name: '', epic_title: '', epic_description: '', epic_color: '#6366f1',
  sprint_template_id: NO_SPRINT_TEMPLATE, task_template_ids: [],
};

function UseTemplateDialog({ template, taskCount, onDone }: { template: EpicTemplate; taskCount: number; onDone: () => void }) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  // Local date — toISOString() is UTC and gives tomorrow for evening users west of UTC.
  const today = todayLocal();

  const [epicTitle, setEpicTitle] = useState(template.epic_title);
  const [startDate, setStartDate] = useState(today);

  const mutation = useMutation({
    mutationFn: (data: { epic_title: string; start_date?: string }) =>
      apiRequest('POST', `/api/epic-templates/${template.id}/use`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/epics'] });
      qc.invalidateQueries({ queryKey: ['/api/sprints'] });
      qc.invalidateQueries({ queryKey: ['/api/tasks'] });
      toast({ title: 'Epic created from template' });
      onDone();
    },
    onError: (err: Error) => toast({ title: 'Failed to create epic', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Epic title</label>
        <Input value={epicTitle} onChange={(e) => setEpicTitle(e.target.value)} maxLength={500} className="mt-1" />
      </div>
      {template.sprint_template_id && (
        <div>
          <label className="text-sm font-medium">Sprint start date</label>
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        This will create the epic{template.sprint_template_id ? ', a sprint,' : ''} and {taskCount} task{taskCount !== 1 ? 's' : ''} linked to it.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>Cancel</Button>
        <Button
          /* Never send '' — a cleared date input omits start_date so the server uses today. */
          onClick={() => mutation.mutate({ epic_title: epicTitle.trim(), ...(template.sprint_template_id && startDate ? { start_date: startDate } : {}) })}
          disabled={!epicTitle.trim() || mutation.isPending}>
          Create
        </Button>
      </div>
    </div>
  );
}

export default function EpicTemplates() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { isAdmin, isLoading: roleLoading } = useMyRole();
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  const [editing,  setEditing]  = useState<EpicTemplate | null>(null);
  const [using,    setUsing]    = useState<EpicTemplate | null>(null);
  const [form,     setForm]     = useState<FormState>(EMPTY_FORM);

  const dialogOpen = creating || !!editing;
  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setCreating(true); };
  const closeDialog = () => { setCreating(false); setEditing(null); };

  const {
    data: templatesData, isLoading: templatesLoading, isError, error, refetch,
  } = useQuery<EpicTemplate[]>({
    queryKey: ['/api/epic-templates'],
    queryFn: () => apiRequest('GET', '/api/epic-templates'),
  });
  const templates = templatesData ?? [];
  const isLoading = templatesLoading || roleLoading;
  const taskTemplatesQuery = useQuery<TaskTemplate[]>({
    queryKey: ['/api/task-templates'],
    queryFn: () => apiRequest('GET', '/api/task-templates'),
  });
  const taskTemplates = taskTemplatesQuery.data ?? [];
  const sprintTemplatesQuery = useQuery<SprintTemplate[]>({
    queryKey: ['/api/sprint-templates'],
    queryFn: () => apiRequest('GET', '/api/sprint-templates'),
  });
  const sprintTemplates = sprintTemplatesQuery.data ?? [];

  const taskTemplateMap = Object.fromEntries(taskTemplates.map((t) => [t.id, t]));
  const sprintTemplateMap = Object.fromEntries(sprintTemplates.map((t) => [t.id, t]));
  // Only judge a referenced template as deleted once the lookup list has actually loaded.
  const taskTemplatesLoaded = taskTemplatesQuery.data !== undefined;
  const sprintTemplatesLoaded = sprintTemplatesQuery.data !== undefined;
  const liveTaskTemplateIds = (ids: string[]) =>
    taskTemplatesLoaded ? ids.filter((id) => id in taskTemplateMap) : ids;

  const openEdit = (t: EpicTemplate) => {
    setCreating(false);
    setForm({
      name: t.name, epic_title: t.epic_title, epic_description: t.epic_description ?? '',
      epic_color: t.epic_color,
      sprint_template_id: t.sprint_template_id && (!sprintTemplatesLoaded || t.sprint_template_id in sprintTemplateMap)
        ? t.sprint_template_id
        : NO_SPRINT_TEMPLATE,
      // Deleted task templates are dropped (they'd be invisible chips and make the save 400).
      task_template_ids: liveTaskTemplateIds(t.task_template_ids),
    });
    setEditing(t);
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ['/api/epic-templates'] });

  // Mirrors the server schema: name 1-255, epic title 1-500 (both trimmed), description <= 5000.
  const formName = form.name.trim();
  const formTitle = form.epic_title.trim();
  const formValid =
    formName.length >= 1 && formName.length <= 255 &&
    formTitle.length >= 1 && formTitle.length <= 500 &&
    form.epic_description.length <= 5000;

  const buildPayload = (f: FormState) => ({
    name: f.name.trim(),
    epic_title: f.epic_title.trim(),
    // null (not undefined) so clearing the description on edit actually persists.
    epic_description: f.epic_description.trim() || null,
    epic_color: f.epic_color,
    sprint_template_id: f.sprint_template_id === NO_SPRINT_TEMPLATE ? null : f.sprint_template_id,
    task_template_ids: liveTaskTemplateIds(f.task_template_ids),
  });

  const createMutation = useMutation({
    mutationFn: (data: ReturnType<typeof buildPayload>) => apiRequest('POST', '/api/epic-templates', data),
    onSuccess: () => { invalidate(); setCreating(false); setForm(EMPTY_FORM); toast({ title: 'Template created' }); },
    onError: (err: Error) => toast({ title: 'Failed to create template', description: err.message, variant: 'destructive' }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: ReturnType<typeof buildPayload>) => apiRequest('PATCH', `/api/epic-templates/${editing!.id}`, data),
    onSuccess: () => { invalidate(); closeDialog(); toast({ title: 'Template updated' }); },
    onError: (err: Error) => toast({ title: 'Failed to update template', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/epic-templates/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Template deleted' }); },
    onError: (err: Error) => toast({ title: 'Failed to delete template', description: err.message, variant: 'destructive' }),
  });

  const toggleTaskTemplate = (id: string) => {
    setForm((f) => ({
      ...f,
      task_template_ids: f.task_template_ids.includes(id)
        ? f.task_template_ids.filter((x) => x !== id)
        : [...f.task_template_ids, id],
    }));
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Epic Templates</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Project-kickoff blueprints: an epic, an optional sprint, and a set of tasks — created together.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={openCreate} className="gap-2">
            <Plus className="h-4 w-4" /> New Template
          </Button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{editing ? 'Edit Epic Template' : 'New Epic Template'}</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            <div>
              <label className="text-sm font-medium">Template name</label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. New client kickoff" maxLength={255} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Epic title</label>
              <Input value={form.epic_title} onChange={(e) => setForm({ ...form, epic_title: e.target.value })}
                maxLength={500} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Epic description (optional)</label>
              <Textarea value={form.epic_description} onChange={(e) => setForm({ ...form, epic_description: e.target.value })}
                rows={2} className="mt-1" />
              {form.epic_description.length > 5000 && (
                <p className="text-xs text-destructive mt-1">Description must be 5000 characters or fewer.</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">Epic color</label>
              <input type="color" value={form.epic_color}
                onChange={(e) => setForm({ ...form, epic_color: e.target.value })}
                className="h-7 w-10 rounded border" />
            </div>
            <div>
              <label className="text-sm font-medium">Sprint template (optional)</label>
              <Select value={form.sprint_template_id} onValueChange={(v) => setForm({ ...form, sprint_template_id: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SPRINT_TEMPLATE}>None</SelectItem>
                  {sprintTemplates.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {sprintTemplatesQuery.isError && !sprintTemplatesQuery.data && (
                <QueryError error={sprintTemplatesQuery.error} onRetry={() => sprintTemplatesQuery.refetch()} className="mt-1" />
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Task templates</label>
              {taskTemplatesQuery.isError && !taskTemplatesQuery.data ? (
                <QueryError error={taskTemplatesQuery.error} onRetry={() => taskTemplatesQuery.refetch()} className="mt-1" />
              ) : taskTemplates.length === 0 ? (
                <p className="text-xs text-muted-foreground mt-1">No task templates yet — create some under Task Templates first.</p>
              ) : (
                <div className="flex flex-wrap gap-2 mt-2">
                  {taskTemplates.map((tt) => (
                    <button key={tt.id} type="button" onClick={() => toggleTaskTemplate(tt.id)}
                      className={`text-xs px-2 py-1 rounded border transition-colors ${
                        form.task_template_ids.includes(tt.id)
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border text-muted-foreground hover:border-foreground'
                      }`}>
                      {tt.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button
                onClick={() => (editing ? updateMutation.mutate(buildPayload(form)) : createMutation.mutate(buildPayload(form)))}
                disabled={!formValid || createMutation.isPending || updateMutation.isPending}>
                {editing ? 'Update Template' : 'Save Template'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!using} onOpenChange={() => setUsing(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Start project from "{using?.name}"</DialogTitle></DialogHeader>
          {using && (
            <UseTemplateDialog
              template={using}
              taskCount={liveTaskTemplateIds(using.task_template_ids).length}
              onDone={() => setUsing(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : isError && !templatesData ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : templates.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Layers className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No epic templates yet. Create one to speed up project kickoffs.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full inline-block shrink-0" style={{ backgroundColor: t.epic_color }} />
                  {t.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                <p className="text-sm text-muted-foreground">{t.epic_title}</p>
                <div className="flex flex-wrap gap-1">
                  {t.sprint_template_id && (
                    sprintTemplateMap[t.sprint_template_id] || !sprintTemplatesLoaded ? (
                      <Badge variant="outline" className="text-[10px]">
                        {sprintTemplateMap[t.sprint_template_id]?.name ?? 'Sprint template'}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground line-through" title="This sprint template was deleted">
                        Missing sprint template
                      </Badge>
                    )
                  )}
                  {t.task_template_ids.map((id) => (
                    taskTemplateMap[id] || !taskTemplatesLoaded ? (
                      <Badge key={id} variant="secondary" className="text-[10px]">
                        {taskTemplateMap[id]?.name ?? 'Task template'}
                      </Badge>
                    ) : (
                      <Badge key={id} variant="outline" className="text-[10px] text-muted-foreground line-through" title="This task template was deleted and will be skipped">
                        Missing task template
                      </Badge>
                    )
                  ))}
                </div>
                {/* /use is requireAdmin server-side, so the whole action row is admin-only. */}
                {isAdmin && (
                <div className="flex gap-2 pt-1">
                  <Button size="sm" className="gap-1 flex-1" onClick={() => setUsing(t)}>
                    <Play className="h-3.5 w-3.5" /> Use Template
                  </Button>
                    <>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive"
                        onClick={() => { if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id); }} disabled={deleteMutation.isPending}>
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
