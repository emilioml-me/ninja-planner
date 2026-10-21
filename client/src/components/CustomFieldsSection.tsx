import { useState, useEffect, useMemo, useRef } from 'react';
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
  // NUMERIC column: pg returns it as a string on the wire.
  value_number: string | number | null;
  value_date: string | null;
}

/** Sentinel for the select "None" option (Radix Select items can't have an empty value). */
const NONE_VALUE = '__none__';

/** Registers (or, with null, unregisters) the section's save function with a parent form. */
export type RegisterCustomFieldsSave = (save: (() => Promise<void>) | null) => void;

export interface CustomFieldsSectionProps {
  entityType: 'task' | 'client';
  entityId: string;
  /**
   * When given, the section hides its own Save button and hands its save function to the parent,
   * which awaits it inside its own submit (TaskFormDialog "Update Task", Clients "Update"). The
   * save is a no-op when nothing was edited and rejects when values haven't loaded yet.
   */
  registerSave?: RegisterCustomFieldsSave;
}

function storedToString(v: FieldValue): string {
  if (v.value_text != null) return v.value_text;
  if (v.value_number != null) return String(Number(v.value_number));
  if (v.value_date) return v.value_date.slice(0, 10);
  return '';
}

/**
 * Custom field values for a task or a client. Only fields the user actually edited are sent
 * (the server accepts a partial set), so unloaded / failed values, stale definitions or a select
 * option removed after a value was stored can't wipe or block the other fields. Values that
 * arrive after the user started typing never replace the edited fields.
 */
export function CustomFieldsSection({ entityType, entityId, registerSave }: CustomFieldsSectionProps) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();

  const valuesPath = entityType === 'task'
    ? `/api/custom-fields/values/${entityId}`
    : `/api/custom-fields/values/client/${entityId}`;
  const valuesKey = ['/api/custom-fields', 'values', entityType, entityId];

  const defsQuery = useQuery<FieldDef[]>({
    queryKey: ['/api/custom-fields', entityType],
    queryFn: () => apiRequest<FieldDef[]>('GET', `/api/custom-fields?entity_type=${entityType}`),
  });
  const defs = useMemo(() => defsQuery.data ?? [], [defsQuery.data]);

  const valuesQuery = useQuery<FieldValue[]>({
    queryKey: valuesKey,
    queryFn: () => apiRequest<FieldValue[]>('GET', valuesPath),
    enabled: defs.length > 0,
  });
  const values = valuesQuery.data;
  const valuesLoaded = values !== undefined;

  // Stored values as form strings. Derived (not copied into state), so a late or refetched
  // response updates untouched fields without ever replacing what the user typed.
  const stored = useMemo(() => {
    const out: Record<string, string> = {};
    for (const v of values ?? []) out[v.field_def_id] = storedToString(v);
    return out;
  }, [values]);

  // Only the fields the user edited, keyed by definition id.
  const [edits, setEdits] = useState<Record<string, string>>({});

  // Reset edits when the section is pointed at a different entity.
  useEffect(() => { setEdits({}); }, [entityType, entityId]);

  const currentValue = (id: string) => edits[id] ?? stored[id] ?? '';
  const setField = (id: string, value: string) => setEdits((prev) => ({ ...prev, [id]: value }));

  const changedEntries = () => {
    const defById = new Map(defs.map((d) => [d.id, d]));
    const entries: { field_def_id: string; value_text: string | null; value_number: number | null; value_date: string | null }[] = [];
    for (const [id, raw] of Object.entries(edits)) {
      const d = defById.get(id);
      // A definition deleted since the edit: drop it instead of 404ing the whole save.
      if (!d) continue;
      if (raw === (stored[id] ?? '')) continue;
      const trimmed = raw.trim();
      if (d.field_type === 'number' && trimmed !== '' && !Number.isFinite(Number(trimmed))) {
        throw new Error(`"${d.name}" must be a number`);
      }
      entries.push({
        field_def_id: d.id,
        value_text: d.field_type === 'text' || d.field_type === 'url' || d.field_type === 'select' ? (trimmed || null) : null,
        value_number: d.field_type === 'number' ? (trimmed ? Number(trimmed) : null) : null,
        value_date: d.field_type === 'date' ? (trimmed || null) : null,
      });
    }
    return entries;
  };

  const save = async (): Promise<void> => {
    if (Object.keys(edits).length === 0) return;
    if (!valuesLoaded) throw new Error('Custom field values have not loaded yet; try again in a moment.');
    const entries = changedEntries();
    if (entries.length > 0) {
      try {
        await apiRequest('PUT', valuesPath, entries);
      } catch (err) {
        // A definition may have been deleted or changed elsewhere: refresh so the next try is
        // made against current definitions.
        qc.invalidateQueries({ queryKey: ['/api/custom-fields'] });
        throw err;
      }
    }
    setEdits({});
    await qc.invalidateQueries({ queryKey: valuesKey });
  };

  // Hand the latest save to the parent through a stable wrapper.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!registerSave) return;
    registerSave(() => saveRef.current());
    return () => registerSave(null);
  }, [registerSave]);

  const saveMut = useMutation({
    mutationFn: () => saveRef.current(),
    onSuccess: () => toast({ title: 'Custom fields saved' }),
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (defs.length === 0) return null;

  return (
    <div className="space-y-3">
      <Separator />
      <p className="text-sm font-medium flex items-center gap-1.5">
        <Settings2 className="h-3.5 w-3.5" /> Custom Fields
      </p>
      {valuesQuery.isError && !valuesLoaded && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span>Could not load custom field values.</span>
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => valuesQuery.refetch()}>
            Retry
          </Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {defs.map((d) => {
          const value = currentValue(d.id);
          const options = d.options ?? [];
          // Keep a stored value whose option was later removed from the definition visible.
          const orphan = value !== '' && !options.includes(value) ? value : null;
          return (
            <div key={d.id} className="space-y-1">
              <Label className="text-xs">{d.name}</Label>
              {d.field_type === 'select' ? (
                <Select
                  value={value === '' ? NONE_VALUE : value}
                  onValueChange={(v) => setField(d.id, v === NONE_VALUE ? '' : v)}
                  disabled={!valuesLoaded}
                >
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_VALUE}>None</SelectItem>
                    {orphan && <SelectItem value={orphan}>{orphan} (removed option)</SelectItem>}
                    {options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="h-8 text-sm"
                  type={d.field_type === 'number' ? 'number' : d.field_type === 'date' ? 'date' : 'text'}
                  step={d.field_type === 'number' ? 'any' : undefined}
                  value={value}
                  disabled={!valuesLoaded}
                  onChange={(e) => setField(d.id, e.target.value)}
                />
              )}
            </div>
          );
        })}
      </div>
      {!registerSave && (
        <Button
          type="button" size="sm" variant="outline"
          disabled={saveMut.isPending || !valuesLoaded || Object.keys(edits).length === 0}
          onClick={() => saveMut.mutate()}
        >
          {saveMut.isPending ? 'Saving...' : 'Save Custom Fields'}
        </Button>
      )}
    </div>
  );
}
