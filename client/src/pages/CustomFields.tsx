import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient, ApiError } from '@/lib/api';
import { useIsAdmin, useIsAdminLoaded } from '@/hooks/use-is-admin';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Settings2, GripVertical, Pencil } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { QueryError } from '@/components/QueryError';

interface FieldDef {
  id: string;
  name: string;
  field_type: 'text' | 'number' | 'url' | 'date' | 'select';
  entity_type: 'task' | 'client';
  options: string[] | null;
  position: number;
  created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  text: 'Text', number: 'Number', url: 'URL', date: 'Date', select: 'Select',
};

const ENTITY_LABELS: Record<string, string> = {
  task: 'Tasks', client: 'Clients',
};

// Mirrors the server's defSchema (src/routes/customFields.ts).
const NAME_MAX = 100;
const OPTION_MAX = 100;
const OPTIONS_MAX = 50;

function parseOptions(raw: string): string[] {
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

/** Returns an error message, or null when the options are valid for a select field. */
function validateOptions(options: string[]): string | null {
  if (options.length === 0) return 'A select field needs at least one option';
  if (options.length > OPTIONS_MAX) return `At most ${OPTIONS_MAX} options`;
  const tooLong = options.find((o) => o.length > OPTION_MAX);
  if (tooLong) return `Option "${tooLong.slice(0, 20)}..." is longer than ${OPTION_MAX} characters`;
  const seen = new Set<string>();
  for (const o of options) {
    const key = o.toLowerCase();
    if (seen.has(key)) return `Duplicate option "${o}"`;
    seen.add(key);
  }
  return null;
}

const CUSTOM_FIELDS_KEY = ['/api/custom-fields'] as const;

export default function CustomFields() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const isAdminLoaded = useIsAdminLoaded();
  const { toast } = useToast();

  // One dialog for create and edit; `editing` set = edit mode (type/entity are fixed then).
  const [creating,     setCreating]     = useState(false);
  const [editing,      setEditing]      = useState<FieldDef | null>(null);
  const [newName,      setNewName]      = useState('');
  const [newType,      setNewType]      = useState<FieldDef['field_type']>('text');
  const [newEntity,    setNewEntity]    = useState<FieldDef['entity_type']>('task');
  const [newOptions,   setNewOptions]   = useState('');

  const { data, isLoading, isError, error, refetch } = useQuery<FieldDef[]>({
    queryKey: CUSTOM_FIELDS_KEY,
    queryFn: () => apiRequest('GET', '/api/custom-fields'),
    enabled: isAdminLoaded && isAdmin,
  });
  const fields = data ?? [];

  // Prefix invalidation also refreshes every CustomFieldsSection (['/api/custom-fields', entityType]).
  const invalidate = () => qc.invalidateQueries({ queryKey: CUSTOM_FIELDS_KEY });

  const dialogOpen = creating || editing !== null;
  const closeDialog = () => {
    setCreating(false);
    setEditing(null);
    setNewName('');
    setNewType('text');
    setNewEntity('task');
    setNewOptions('');
  };

  const openEdit = (f: FieldDef) => {
    setCreating(false);
    setEditing(f);
    setNewName(f.name);
    setNewType(f.field_type);
    setNewEntity(f.entity_type);
    setNewOptions((f.options ?? []).join(', '));
  };

  const createMutation = useMutation({
    mutationFn: (body: { name: string; field_type: string; entity_type: string; options?: string[] }) =>
      apiRequest('POST', '/api/custom-fields', body),
    onSuccess: () => {
      invalidate();
      closeDialog();
      toast({ title: 'Field created' });
    },
    onError: (err: Error) => toast({ title: 'Failed to create field', description: err.message, variant: 'destructive' }),
  });

  type DefPatch = { name?: string; options?: string[]; clear_invalid_values?: boolean };
  const updateMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: DefPatch }) => {
      try {
        return await apiRequest('PATCH', `/api/custom-fields/${id}`, body);
      } catch (err) {
        // Removing options that stored values still use: 409 with the count. Ask before clearing.
        const stranded = err instanceof ApiError && err.status === 409
          ? Number((err.body as { stranded_values?: unknown } | undefined)?.stranded_values ?? 0)
          : 0;
        if (stranded > 0 && !body.clear_invalid_values) {
          const ok = window.confirm(
            `${stranded} stored value${stranded === 1 ? '' : 's'} use${stranded === 1 ? 's' : ''} an option you are removing. ` +
            'Save anyway and clear those values? This cannot be undone.',
          );
          if (ok) return apiRequest('PATCH', `/api/custom-fields/${id}`, { ...body, clear_invalid_values: true });
          throw new Error('Not saved: some items still use the removed options.');
        }
        throw err;
      }
    },
    onSuccess: () => {
      invalidate();
      closeDialog();
      toast({ title: 'Field updated' });
    },
    onError: (err: Error) => toast({ title: 'Failed to update field', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/custom-fields/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Field deleted' }); },
    onError: (err: Error) => toast({ title: 'Failed to delete field', description: err.message, variant: 'destructive' }),
  });

  const trimmedName = newName.trim();
  const parsedOptions = newType === 'select' ? parseOptions(newOptions) : [];
  const optionsError = newType === 'select' ? validateOptions(parsedOptions) : null;
  const nameError = trimmedName.length > NAME_MAX ? `At most ${NAME_MAX} characters` : null;
  const removedOptions = editing && editing.field_type === 'select'
    ? (editing.options ?? []).filter((o) => !parsedOptions.includes(o))
    : [];
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const canSubmit = !!trimmedName && !nameError && !optionsError && !isSaving;

  function handleSubmit() {
    if (!canSubmit) return;
    if (editing) {
      const body: { name?: string; options?: string[] } = {};
      if (trimmedName !== editing.name) body.name = trimmedName;
      if (editing.field_type === 'select') {
        const before = editing.options ?? [];
        const changed = before.length !== parsedOptions.length || before.some((o, i) => o !== parsedOptions[i]);
        if (changed) body.options = parsedOptions;
      }
      if (Object.keys(body).length === 0) { closeDialog(); return; }
      updateMutation.mutate({ id: editing.id, body });
      return;
    }
    createMutation.mutate({
      name: trimmedName,
      field_type: newType,
      entity_type: newEntity,
      options: newType === 'select' ? parsedOptions : undefined,
    });
  }

  // Wait for Clerk to resolve so real admins don't see a flash of "Admin access required".
  if (!isAdminLoaded) {
    return (
      <div className="p-6 space-y-3">{[1,2,3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-2">Custom Fields</h1>
        <p className="text-muted-foreground">Admin access required to manage custom fields.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Custom Fields</h1>
          <p className="text-muted-foreground text-sm mt-1">Add extra fields to tasks and clients for your team's workflow</p>
        </div>
        <Button onClick={() => { closeDialog(); setCreating(true); }} className="gap-2">
          <Plus className="h-4 w-4" /> New Field
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Edit Custom Field' : 'New Custom Field'}</DialogTitle></DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
            <div>
              <label className="text-sm font-medium">Field name</label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={NAME_MAX}
                placeholder="e.g. Story Points, Client Name, Review URL" className="mt-1" />
              {nameError && <p className="text-xs text-destructive mt-1">{nameError}</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Applies to</label>
                <Select value={newEntity} onValueChange={(v) => setNewEntity(v as FieldDef['entity_type'])} disabled={!!editing}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(ENTITY_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">Type</label>
                <Select value={newType} onValueChange={(v) => setNewType(v as FieldDef['field_type'])} disabled={!!editing}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {editing && (
              <p className="text-xs text-muted-foreground -mt-2">
                The type and entity of an existing field can't be changed. Delete and recreate it instead (this deletes its values).
              </p>
            )}
            {newType === 'select' && (
              <div>
                <label className="text-sm font-medium">Options (comma-separated)</label>
                <Input value={newOptions} onChange={(e) => setNewOptions(e.target.value)}
                  placeholder="Option A, Option B, Option C" className="mt-1" />
                {optionsError && newOptions.trim() !== '' && (
                  <p className="text-xs text-destructive mt-1">{optionsError}</p>
                )}
                {optionsError && newOptions.trim() === '' && (
                  <p className="text-xs text-muted-foreground mt-1">Add at least one option.</p>
                )}
                {!optionsError && removedOptions.length > 0 && (
                  <p className="text-xs text-amber-600 mt-1">
                    Removing {removedOptions.map((o) => `"${o}"`).join(', ')}. If items still use a removed option you'll be asked before those values are cleared.
                  </p>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={closeDialog}>Cancel</Button>
              <Button type="submit" disabled={!canSubmit}>
                {isSaving ? 'Saving...' : editing ? 'Save' : 'Create'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : isLoading ? (
        <div className="space-y-3">{[1,2,3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : fields.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">
          <Settings2 className="h-10 w-10 mx-auto mb-3 opacity-30" />
          No custom fields yet. Fields you create here appear in the task form.
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f) => (
            <Card key={f.id}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center gap-3">
                  <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <span className="font-medium text-sm">{f.name}</span>
                    {f.options && f.options.length > 0 && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {f.options.slice(0,4).join(', ')}{f.options.length > 4 ? '…' : ''}
                      </span>
                    )}
                  </div>
                  <Badge variant="outline" className="text-xs">{ENTITY_LABELS[f.entity_type]}</Badge>
                  <Badge variant="secondary" className="text-xs">{TYPE_LABELS[f.field_type]}</Badge>
                  <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit field ${f.name}`}
                    onClick={() => openEdit(f)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" aria-label={`Delete field ${f.name}`}
                    onClick={() => {
                      if (confirm(`Delete field "${f.name}"? Every value stored for this field on all ${f.entity_type === 'client' ? 'clients' : 'tasks'} will be permanently deleted.`)) {
                        deleteMutation.mutate(f.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Task fields appear in the task edit dialog; client fields appear in the client edit dialog. Values are visible to all workspace members.
      </p>
    </div>
  );
}
