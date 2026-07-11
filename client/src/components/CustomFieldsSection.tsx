import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Settings2 } from 'lucide-react';

interface FieldDef {
  id: string;
  name: string;
  field_type: 'text' | 'number' | 'url' | 'date' | 'select';
  options: string[] | null;
}

interface FieldValue {
  field_def_id: string;
  value_text: string | null;
  value_number: number | null;
  value_date: string | null;
}

/**
 * Custom field values had no UI consumer anywhere in the app before this — definitions could
 * be created on the Custom Fields settings page, but there was nothing to actually set a value
 * against a task (or now, a client). This component is shared between TaskFormDialog and
 * Clients.tsx rather than duplicated per entity.
 */
export function CustomFieldsSection({
  entityType, entityId,
}: {
  entityType: 'task' | 'client';
  entityId: string;
}) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const valuesPath = entityType === 'task'
    ? `/api/custom-fields/values/${entityId}`
    : `/api/custom-fields/values/client/${entityId}`;

  const { data: defs = [] } = useQuery<FieldDef[]>({
    queryKey: ['/api/custom-fields', entityType],
    queryFn: () => apiRequest<FieldDef[]>('GET', `/api/custom-fields?entity_type=${entityType}`),
  });

  const { data: values = [] } = useQuery<FieldValue[]>({
    queryKey: [valuesPath],
    queryFn: () => apiRequest<FieldValue[]>('GET', valuesPath),
    enabled: defs.length > 0,
  });

  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const v of values) {
      next[v.field_def_id] = v.value_text ?? (v.value_number != null ? String(v.value_number) : '') ?? v.value_date ?? '';
    }
    setDraft(next);
  }, [values]);

  const saveMut = useMutation({
    mutationFn: () => {
      const entries = defs.map((d) => {
        const raw = draft[d.id] ?? '';
        return {
          field_def_id: d.id,
          value_text: d.field_type === 'text' || d.field_type === 'url' || d.field_type === 'select' ? (raw || null) : null,
          value_number: d.field_type === 'number' ? (raw ? Number(raw) : null) : null,
          value_date: d.field_type === 'date' ? (raw || null) : null,
        };
      });
      return apiRequest('PUT', valuesPath, entries);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [valuesPath] });
      toast({ title: 'Custom fields saved' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (defs.length === 0) return null;

  return (
    <div className="space-y-3">
      <Separator />
      <p className="text-sm font-medium flex items-center gap-1.5">
        <Settings2 className="h-3.5 w-3.5" /> Custom Fields
      </p>
      <div className="grid grid-cols-2 gap-3">
        {defs.map((d) => (
          <div key={d.id} className="space-y-1">
            <Label className="text-xs">{d.name}</Label>
            {d.field_type === 'select' ? (
              <Select
                value={draft[d.id] ?? ''}
                onValueChange={(v) => setDraft((prev) => ({ ...prev, [d.id]: v }))}
              >
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {(d.options ?? []).map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input
                className="h-8 text-sm"
                type={d.field_type === 'number' ? 'number' : d.field_type === 'date' ? 'date' : 'text'}
                value={draft[d.id] ?? ''}
                onChange={(e) => setDraft((prev) => ({ ...prev, [d.id]: e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <Button type="button" size="sm" variant="outline" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
        {saveMut.isPending ? 'Saving…' : 'Save Custom Fields'}
      </Button>
    </div>
  );
}
