import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { useMembers } from '@/hooks/use-members';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { BarChart2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WorkloadRow {
  assignee_clerk_id: string;
  status: string;
  count: number;
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  todo:        { label: 'To Do',       color: 'bg-slate-400'  },
  in_progress: { label: 'In Progress', color: 'bg-blue-500'   },
  blocked:     { label: 'Blocked',     color: 'bg-red-500'    },
  done:        { label: 'Done',        color: 'bg-green-500'  },
};

const STATUS_ORDER = ['todo', 'in_progress', 'blocked', 'done'];

export default function Workload() {
  const { apiRequest } = useApiClient();
  const { data: rows = [], isLoading: rowsLoading } = useQuery<WorkloadRow[]>({
    queryKey: ['/api/tasks/workload'],
    queryFn: () => apiRequest('GET', '/api/tasks/workload'),
    staleTime: 60_000,
  });
  const { members, isLoading: membersLoading } = useMembers();

  const isLoading = rowsLoading || membersLoading;

  // Pivot rows into: { [clerkId]: { [status]: count } }
  const byMember = rows.reduce<Record<string, Record<string, number>>>((acc, r) => {
    if (!acc[r.assignee_clerk_id]) acc[r.assignee_clerk_id] = {};
    acc[r.assignee_clerk_id][r.status] = r.count;
    return acc;
  }, {});

  // Sort members by total task count descending
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <BarChart2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Team Workload</h1>
          <p className="text-sm text-muted-foreground">Active tasks per team member by status.</p>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3">
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

      {/* Workload bars */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
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
          <p className="text-xs text-muted-foreground mt-1">Assign tasks to team members to see their workload here.</p>
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

                {/* Stacked progress bar */}
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

                {/* Per-status breakdown */}
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
    </div>
  );
}
