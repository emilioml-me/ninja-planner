import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useMembers } from '@/hooks/use-members';
import { useMyRole } from '@/hooks/use-is-admin';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { QueryError } from '@/components/QueryError';
import { BarChart2, Gauge, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkloadRow {
  assignee_clerk_id: string;
  status: string;
  count: number;
}

// Point sums can arrive as NUMERIC strings; always read them through Number().
interface CapacityRow {
  user_clerk_id: string;
  assigned_points: number | string;
  task_count: number | string;
  capacity_points: number | string;
  /** Points of not-done tasks in the sprint. */
  remaining_points?: number | string;
  /** True when capacity_points comes from a per-sprint override (then sprint_id is set). */
  is_override?: boolean;
  sprint_id?: string | null;
}

const MAX_CAPACITY = 500;

/** Parses the capacity input; null when it isn't a whole number in 0..MAX_CAPACITY. */
function parseCapacity(val: string): number | null {
  if (!/^\d+$/.test(val.trim())) return null;
  const n = Number(val);
  return n <= MAX_CAPACITY ? n : null;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  todo:        { label: 'To Do',       color: 'bg-slate-400'  },
  in_progress: { label: 'In Progress', color: 'bg-blue-500'   },
  blocked:     { label: 'Blocked',     color: 'bg-red-500'    },
  done:        { label: 'Done',        color: 'bg-green-500'  },
};
const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'done'];

function CapacityEditor({
  memberName, current, onSave,
}: { memberName: string; current: number; onSave: (pts: number) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [val, setVal] = useState(String(current));
  const parsed = parseCapacity(val);
  // Stays open until the PUT resolves; on failure the typed value and the reason remain visible.
  const save = async () => {
    if (parsed === null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save capacity');
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { setEditing(false); setSaveError(null); };

  if (!editing) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => { setVal(String(current)); setSaveError(null); setEditing(true); }}
      >
        <Pencil className="h-3 w-3" /> {current} pts capacity
      </button>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <Input
          type="number" min={0} max={MAX_CAPACITY}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className={cn('h-6 w-20 text-xs', parsed === null && 'border-destructive')}
          aria-label={`Capacity points for ${memberName}`}
          title={parsed === null ? `Enter a whole number from 0 to ${MAX_CAPACITY}` : undefined}
          disabled={saving}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') cancel();
          }}
        />
        <Button size="icon" variant="ghost" className="h-6 w-6" disabled={parsed === null || saving}
          aria-label="Save capacity" onClick={() => void save()}>
          <Check className="h-3 w-3 text-green-600" />
        </Button>
        <Button size="icon" variant="ghost" className="h-6 w-6" disabled={saving}
          aria-label="Cancel" onClick={cancel}>
          <X className="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>
      {saveError && <p className="text-[11px] text-destructive">{saveError}</p>}
    </div>
  );
}

export default function Workload() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAdmin } = useMyRole();

  // Keys live under the ['/api/tasks', ...] prefix so every task mutation's
  // invalidateQueries({ queryKey: ['/api/tasks'] }) also refreshes these views.
  const {
    data: rowsData, isLoading: rowsLoading, isError: rowsIsError, error: rowsError, refetch: refetchRows,
  } = useQuery<WorkloadRow[]>({
    queryKey: ['/api/tasks', 'workload'],
    queryFn: () => apiRequest('GET', '/api/tasks/workload'),
    staleTime: 60_000,
  });
  const rows = rowsData ?? [];
  const {
    data: capacityData, isLoading: capLoading, isError: capIsError, error: capError, refetch: refetchCap,
  } = useQuery<CapacityRow[]>({
    queryKey: ['/api/tasks', 'capacity', 'active'],
    queryFn: () => apiRequest('GET', '/api/tasks/capacity'),
    staleTime: 60_000,
  });
  const capacityRows = capacityData ?? [];
  const { members, isLoading: membersLoading } = useMembers();
  const isLoading = rowsLoading || membersLoading;

  // Edits the value being DISPLAYED: when the shown capacity is a per-sprint override, update
  // that override (sprint_id) instead of silently writing the workspace default underneath it.
  const saveCapacity = useMutation({
    mutationFn: ({ memberId, pts, sprintId }: { memberId: string; pts: number; sprintId?: string | null }) =>
      apiRequest('PUT', `/api/tasks/capacity/${memberId}`, {
        capacity_points: Math.min(MAX_CAPACITY, Math.max(0, pts)),
        ...(sprintId ? { sprint_id: sprintId } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', 'capacity'] });
      toast({ title: 'Capacity updated' });
    },
    // Failures are shown inline by CapacityEditor (which awaits mutateAsync).
  });

  // Pivot workload rows
  const byMember = rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
    if (!acc[r.assignee_clerk_id]) acc[r.assignee_clerk_id] = {};
    acc[r.assignee_clerk_id][r.status] = Number(r.count);
    return acc;
  }, {});

  // Workload = OPEN work. The endpoint counts all-time done tasks too, which previously
  // dominated both the bar widths and the sort order; done is shown as a side note instead.
  const openTotal = (counts: Record<string, number>) =>
    Object.entries(counts).reduce((sum, [status, n]) => (status === 'done' ? sum : sum + n), 0);

  const memberIds = Object.keys(byMember)
    .filter((id) => openTotal(byMember[id]) > 0)
    .sort((a, b) => openTotal(byMember[b]) - openTotal(byMember[a]));

  const maxTotal = memberIds.reduce((max, id) => Math.max(max, openTotal(byMember[id])), 1);
  const OPEN_STATUSES = STATUS_ORDER.filter((st) => st !== 'done');

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));
  // Tasks can still be assigned to someone who has left the workspace.
  const nameFor = (clerkId: string) => memberMap[clerkId]?.display_name ?? 'Former member';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <BarChart2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Team Workload</h1>
          <p className="text-sm text-muted-foreground">Tasks and capacity per team member.</p>
        </div>
      </div>

      <Tabs defaultValue="workload">
        <TabsList>
          <TabsTrigger value="workload" className="gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" /> Workload
          </TabsTrigger>
          <TabsTrigger value="capacity" className="gap-1.5">
            <Gauge className="h-3.5 w-3.5" /> Capacity
          </TabsTrigger>
        </TabsList>

        {/* ── Workload tab ── */}
        <TabsContent value="workload" className="mt-4">
          {/* Legend */}
          <div className="flex flex-wrap gap-3 mb-5">
            {OPEN_STATUSES.map((s) => {
              const meta = STATUS_META[s];
              return (
                <div key={s} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={cn('h-2.5 w-2.5 rounded-sm', meta.color)} />
                  {meta.label}
                </div>
              );
            })}
          </div>

          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-5 w-full rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : rowsIsError && !rowsData ? (
            <QueryError error={rowsError} onRetry={() => refetchRows()} />
          ) : memberIds.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <BarChart2 className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">No open assigned tasks</p>
            </div>
          ) : (
            <div className="space-y-5">
              {memberIds.map((clerkId) => {
                const statusCounts = byMember[clerkId];
                const total = openTotal(statusCounts);
                const displayName = nameFor(clerkId);
                const initials = displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

                return (
                  <div key={clerkId} className="space-y-1.5">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarFallback className="text-[10px] bg-muted">{initials}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium flex-1 min-w-0 truncate">{displayName}</span>
                      <Badge variant="secondary" className="text-xs shrink-0">{total} open task{total !== 1 ? 's' : ''}</Badge>
                    </div>
                    {/* The member's bar is sized against the busiest member; its segments share
                        that width by count (flex-grow) so per-segment minimums can't overflow it. */}
                    <div className="h-5 rounded-md overflow-hidden bg-muted">
                      <div
                        className="flex h-full gap-px max-w-full"
                        style={{
                          width: `${(total / maxTotal) * 100}%`,
                          minWidth: `${OPEN_STATUSES.filter((s) => (statusCounts[s] ?? 0) > 0).length * 1.5}rem`,
                        }}
                      >
                        {OPEN_STATUSES.map((status) => {
                          const count = statusCounts[status] ?? 0;
                          if (count === 0) return null;
                          const meta = STATUS_META[status];
                          return (
                            <div
                              key={status}
                              className={cn('flex items-center justify-center text-[10px] font-medium text-white transition-all overflow-hidden', meta.color)}
                              style={{ flexGrow: count, flexBasis: 0, minWidth: '1.5rem' }}
                              title={`${meta.label}: ${count}`}
                            >
                              {count}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-3 pl-10">
                      {STATUS_ORDER.filter((s) => statusCounts[s]).map((s) => (
                        <span key={s} className="text-xs text-muted-foreground">
                          <span className={cn('inline-block h-2 w-2 rounded-sm mr-1 align-middle', STATUS_META[s].color)} />
                          {statusCounts[s]} {STATUS_META[s].label}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Capacity tab ── */}
        <TabsContent value="capacity" className="mt-4">
          <p className="text-xs text-muted-foreground mb-4">
            Story points assigned in the active sprint vs each member's configured capacity.
            {isAdmin && ' Click the pencil to adjust a member\'s capacity.'}
          </p>
          {capLoading || membersLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : capIsError && !capacityData ? (
            <QueryError error={capError} onRetry={() => refetchCap()} />
          ) : capacityRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Gauge className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">No members to show</p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* The endpoint lists every member; sprint_id is null on all rows when no sprint is active. */}
              {capacityRows.every((r) => !r.sprint_id) && (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground flex items-center gap-2">
                  <Gauge className="h-4 w-4 shrink-0" />
                  No active sprint. Showing each member's default capacity; start a sprint to see assigned points.
                </div>
              )}
              {capacityRows.map((row) => {
                const displayName = nameFor(row.user_clerk_id);
                const initials = displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
                const assigned = Number(row.assigned_points) || 0;
                const capacity = Number(row.capacity_points) || 0;
                const taskCount = Number(row.task_count) || 0;
                const remaining = row.remaining_points != null ? Number(row.remaining_points) || 0 : null;
                const overloaded = assigned > capacity;
                // Capacity 0 with work assigned is fully over, not an empty bar.
                const pct = capacity > 0
                  ? Math.min(Math.round((assigned / capacity) * 100), 100)
                  : overloaded ? 100 : 0;

                return (
                  <Card key={row.user_clerk_id} className={cn(overloaded && 'border-destructive/40')}>
                    <CardContent className="pt-4 pb-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-7 w-7 shrink-0">
                          <AvatarFallback className="text-[10px] bg-muted">{initials}</AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium truncate">{displayName}</span>
                            <span className={cn('text-xs font-medium shrink-0', overloaded ? 'text-destructive' : 'text-muted-foreground')}>
                              {assigned} / {capacity} pts assigned
                              {remaining !== null && ` · ${remaining} open`}
                              {overloaded && ' ⚠️ over'}
                            </span>
                          </div>
                          {isAdmin ? (
                            <div className="flex items-center gap-2">
                              <CapacityEditor
                                memberName={displayName}
                                current={capacity}
                                onSave={(pts) => saveCapacity.mutateAsync({
                                  memberId: row.user_clerk_id,
                                  pts,
                                  sprintId: row.is_override ? row.sprint_id : null,
                                })}
                              />
                              {row.is_override && <span className="text-[10px] text-muted-foreground">(sprint override)</span>}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {capacity} pts capacity{row.is_override ? ' (sprint override)' : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn('h-full rounded-full transition-all', overloaded ? 'bg-destructive' : 'bg-primary')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">{taskCount} task{taskCount !== 1 ? 's' : ''} in active sprint</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
