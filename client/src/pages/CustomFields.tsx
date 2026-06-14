import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Trash2, Settings2, GripVertical } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface FieldDef {
  id: string;
  name: string;
  field_type: 'text' | 'number' | 'url' | 'date' | 'select';
  options: string[] | null;
  position: number;
  created_at: string;
}

const TYPE_LABELS: Record<string, string> = {
  text: 'Text', number: 'Number', url: 'URL', date: 'Date', select: 'Select',
};

export default function CustomFields() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { toast } = useToast();

  const [creating,     setCreating]     = useState(false);
  const [newName,      setNewName]      = useState('');
  const [newType,      setNewType]      = useState<FieldDef['field_type']>('text');
  const [newOptions,   setNewOptions]   = useState('');

  const { data: fields = [], isLoading } = useQuery<FieldDef[]>({
    queryKey: ['custom-fields'],
    queryFn: () => apiRequest('GET', '/api/custom-fields'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['custom-fields'] });

  const createMutation = useMutation({
    mutationFn: (data: { name: string; field_type: string; options?: string[] }) =>
      apiRequest('POST', '/api/custom-fields', data),
    onSuccess: () => {
      invalidate();
      setCreating(false);
      setNewName('');
      setNewType('text');
      setNewOptions('');
      toast({ title: 'Field created' });
    },
    onError: () => toast({ title: 'Failed to create field', variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest('DELETE', `/api/custom-fields/${id}`),
    onSuccess: () => { invalidate(); toast({ title: 'Field deleted' }); },
    onError: () => toast({ title: 'Failed to delete field', variant: 'destructive' }),
  });

  function handleCreate() {
    const options = newType === 'select'
      ? newOptions.split(',').map((o) => o.trim()).filter(Boolean)
      : undefined;
    createMutation.mutate({ name: newName, field_type: newType, options });
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
          <p className="text-muted-foreground text-sm mt-1">Add extra fields to tasks for your team's workflow</p>
        </div>
        <Button onClick={() => setCreating(true)} className="gap-2">
          <Plus className="h-4 w-4" /> New Field
        </Button>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Custom Field</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Field name</label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Story Points, Client Name, Review URL" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">Type</label>
              <Select value={newType} onValueChange={(v) => setNewType(v as FieldDef['field_type'])}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {newType === 'select' && (
              <div>
                <label className="text-sm font-medium">Options (comma-separated)</label>
                <Input value={newOptions} onChange={(e) => setNewOptions(e.target.value)}
                  placeholder="Option A, Option B, Option C" className="mt-1" />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={handleCreate}
                disabled={!newName.trim() || createMutation.isPending}>
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {isLoading ? (
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
                  <Badge variant="secondary" className="text-xs">{TYPE_LABELS[f.field_type]}</Badge>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => deleteMutation.mutate(f.id)}
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
        Custom field values appear in the task form under "Custom Fields". Values are stored per-task and visible to all workspace members.
      </p>
    </div>
  );
}
