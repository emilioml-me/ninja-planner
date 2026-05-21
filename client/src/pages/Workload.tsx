import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useMembers } from '@/hooks/use-members';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart2, Gauge, Pencil, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkloadRow {
  assignee_clerk_id: string;
  status: string;
  count: number;
}

interface CapacityRow {
  user_clerk_id: string;
  assigned_points: number;
  task_count: number;
  capacity_points: number;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  todo:        { label: 'To Do',       color: 'bg-slate-400'  },
  in_progress: { label: 'In Progress', color: 'bg-blue-500'   },
  blocked:     { label: 'Blocked',     color: 'bg-red-500'    },
  done:        { label: 'Done',        color: 'bg-green-500'  },
};
const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'done'];

function CapacityEditor({
  clerkId, current, onSave,
}: { clerkId: string; current: number; onSave: (pts: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(current));

  if (!editing) {
    return (
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => { setVal(String(current)); setEditing(true); }}
      >
        <Pencil className="h-3 w-3" /> {current} pts capacity
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number" min={0} max={500}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className="h-6 w-20 text-xs"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') { onSave(Math.max(0, parseInt(val) || 0)); setEditing(false); }
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button size="icon" variant="ghost" className="h-6 w-6"
        onClick={() => { onSave(Math.max(0, parseInt(val) || 0)); setEditing(false); }}>
        <Check className="h-3 w-3 text-green-600" />
      </Button>
      <Button size="icon" variant="ghost" className="h-6 w-6"
        onClick={() => setEditing(false)}>
        <X className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );
}

export default function Workload() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();

  const { data: rows = [], isLoading: rowsLoading } = useQuery<WorkloadRow[]>({
    queryKey: ['/api/tasks/workload'],
    queryFn: () => apiRequest('GET', '/api/tasks/workload'),
    staleTime: 60_000,
  });
  const { data: capacityRows = [], isLoading: capLoading } = useQuery<CapacityRow[]>({
    queryKey: ['/api/tasks/capacity'],
    queryFn: () => apiRequest('GET', '/api/tasks/capacity'),
    staleTime: 60_000,
  });
  const { members, isLoading: membersLoading } = useMembers();
  const isLoading = rowsLoading || membersLoading;

  const saveCapacity = useMutation({
    mutationFn: ({ memberId, pts }: { memberId: string; pts: number }) =>
      apiRequest('PUT', `/api/tasks/capacity/${memberId}`, { capacity_points: pts }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks/capacity'] });
      toast({ title: 'Capacity updated' });
    },
  });

  // Pivot workload rows
  const byMember = rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
    if (!acc[r.assignee_clerk_id]) acc[r.assignee_clerk_id] = {};
    acc[r.assignee_clerk_id][r.status] = r.count;
    return acc;
  }, {});

  const memberIds = Object.keys(byMember).sort((a, b) => {
    const totalA = Object.values(byMember[a]).reduce((s, n) => s + n, 0);
    const totalB = Object.values(byMember[b]).reduce((s, n) => s + n, 0);
    return totalB - totalA;
  });

  const maxTotal = memberIds.reduce((max, id) => {
    const total = Object.values(byMember[id]).reduce((s, n) => s + n, 0);
    return Math.max(max, total);
  }, 1);

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));
  const capMap = Object.fromEntries(capacityRows.map((r) => [r.user_clerk_id, r]));

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
            {STATUS_ORDER.map((s) => {
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
          ) : memberIds.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <BarChart2 className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">No assigned tasks yet</p>
            </div>
          ) : (
            <div className="space-y-5">
              {memberIds.map((clerkId) => {
                const statusCounts = byMember[clerkId];
                const total = Object.values(statusCounts).reduce((s, n) => s + n, 0);
                const member = memberMap[clerkId];
                const displayName = member?.display_name ?? clerkId.slice(-8);
                const initials = displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

                return (
                  <div key={clerkId} className="space-y-1.5">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-7 w-7 shrink-0">
                        <AvatarFallback className="text-[10px] bg-muted">{initials}</AvatarFallback>
                      </Avatar>
                      <span className="text-sm font-medium flex-1 min-w-0 truncate">{displayName}</span>
                      <Badge variant="secondary" className="text-xs shrink-0">{total} task{total !== 1 ? 's' : ''}</Badge>
                    </div>
                    <div className="flex h-5 rounded-md overflow-hidden gap-px bg-muted">
                      {STATUS_ORDER.map((status) => {
                        const count = statusCounts[status] ?? 0;
                        if (count === 0) return null;
                        const pct = (count / maxTotal) * 100;
                        const meta = STATUS_META[status];
                        return (
                          <div
                            key={status}
                            className={cn('flex items-center justify-center text-[10px] font-medium text-white transition-all', meta.color)}
                            style={{ width: `${pct}%`, minWidth: count > 0 ? '1.5rem' : 0 }}
                            title={`${meta.label}: ${count}`}
                          >
                            {count}
                          </div>
                        );
                      })}
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
          ) : capacityRows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Gauge className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium">No active sprint assignments</p>
              <p className="text-xs text-muted-foreground mt-1">Assign tasks with story points to an active sprint to see capacity.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {capacityRows.map((row) => {
                const member = memberMap[row.user_clerk_id];
                const displayName = member?.display_name ?? row.user_clerk_id.slice(-8);
                const initials = displayName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();
                const pct = row.capacity_points > 0
                  ? Math.min(Math.round((row.assigned_points / row.capacity_points) * 100), 100)
                  : 0;
                const overloaded = row.assigned_points > row.capacity_points;

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
                              {row.assigned_points} / {row.capacity_points} pts
                              {overloaded && ' ⚠️ over'}
                            </span>
                          </div>
                          {isAdmin ? (
                            <CapacityEditor
                              clerkId={row.user_clerk_id}
                              current={row.capacity_points}
                              onSave={(pts) => saveCapacity.mutate({ memberId: row.user_clerk_id, pts })}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">{row.capacity_points} pts capacity</span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn('h-full rounded-full transition-all', overloaded ? 'bg-destructive' : 'bg-primary')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">{row.task_count} task{row.task_count !== 1 ? 's' : ''} in active sprint</p>
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
