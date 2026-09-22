import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useMembers } from '@/hooks/use-members';
import { useIsAdmin } from '@/hooks/use-is-admin';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Gauge, Pencil, Check, X, AlertTriangle } from 'lucide-react';
import { cn, safeFormat } from '@/lib/utils';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// ── Sprint Velocity tab ───────────────────────────────────────────────────────

function VelocityTab() {
  const { apiRequest } = useApiClient();
  const { data = [], isLoading } = useQuery<{
    id: string; name: string; start_date: string; end_date: string;
    total_points: number; completed_points: number;
  }[]>({
    queryKey: ['analytics', 'velocity'],
    queryFn: () => apiRequest('GET', '/api/analytics/velocity'),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (!data.length) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        No completed sprints yet. Complete a sprint to see velocity data.
      </div>
    );
  }

  const chartData = data.map((s) => ({
    name: s.name.length > 14 ? s.name.slice(0, 12) + '…' : s.name,
    'Committed': s.total_points,
    'Completed': s.completed_points,
  }));

  const avgVelocity = Math.round(
    data.reduce((s, r) => s + r.completed_points, 0) / data.length,
  );

  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        {[
          { label: 'Avg points / sprint', value: avgVelocity },
          { label: 'Sprints tracked', value: data.length },
          { label: 'Last sprint velocity', value: data[data.length - 1]?.completed_points ?? 0 },
        ].map(({ label, value }) => (
          <Card key={label} className="flex-1">
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-sm text-muted-foreground">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle>Sprint Velocity</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar dataKey="Committed" fill="#e4e4e7" radius={[2,2,0,0]} />
              <Bar dataKey="Completed" fill="#f97316" radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Velocity Trend</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip />
              <Line type="monotone" dataKey="Completed" stroke="#f97316" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Time Report tab ───────────────────────────────────────────────────────────

function TimeReportTab() {
  const { apiRequest } = useApiClient();
  const [from, setFrom] = useState('');
  const [to, setTo]     = useState('');

  const { data, isLoading } = useQuery<{
    rows: {
      id: string; task_title: string; minutes: number; billable: boolean;
      hourly_rate: number | null; user_clerk_id: string; sprint_name: string | null; logged_at: string;
    }[];
    summary: { total_minutes: number; billable_minutes: number; billable_value: number };
    truncated?: boolean;
  }>({
    queryKey: ['analytics', 'time-report', from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      if (from) p.set('from', from);
      if (to)   p.set('to', to);
      return apiRequest('GET', `/api/analytics/time-report?${p}`);
    },
  });

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? { total_minutes: 0, billable_minutes: 0, billable_value: 0 };
  const truncated = data?.truncated ?? false;
  const rangeInvalid = !!from && !!to && from > to;
  const fmtHours = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

  return (
    <div className="space-y-6">
      <div className="flex gap-3 items-end">
        {[['From', from, setFrom], ['To', to, setTo]].map(([label, val, setter]) => (
          <div key={label as string} className="space-y-1">
            <label className="text-xs text-muted-foreground">{label as string}</label>
            <input type="date" value={val as string}
              onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
          </div>
        ))}
        {(from || to) && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setFrom(''); setTo(''); }}>
            Clear
          </Button>
        )}
      </div>
      {rangeInvalid && (
        <p className="text-xs text-destructive">"From" must be on or before "To".</p>
      )}
      {truncated && (
        <p className="flex items-center gap-1.5 text-xs text-yellow-700 dark:text-yellow-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          Only the 1000 most recent entries are listed below; the totals include every entry in the range.
        </p>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <div className="flex gap-4">
            {[
              { label: 'Total logged',   value: fmtHours(summary.total_minutes) },
              { label: 'Billable',       value: fmtHours(summary.billable_minutes) },
              { label: 'Billable value', value: `$${summary.billable_value.toFixed(2)}` },
            ].map(({ label, value }) => (
              <Card key={label} className="flex-1">
                <CardContent className="pt-6">
                  <div className="text-2xl font-bold">{value}</div>
                  <div className="text-sm text-muted-foreground">{label}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No time logs in this range.</div>
          ) : (
            <Card>
              <CardContent className="pt-4">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-left">
                      <th className="py-2 pr-4">Task</th>
                      <th className="py-2 pr-4">Sprint</th>
                      <th className="py-2 pr-4">Time</th>
                      <th className="py-2 pr-4">Billable</th>
                      <th className="py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 pr-4 font-medium">{r.task_title}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{r.sprint_name ?? '—'}</td>
                        <td className="py-2 pr-4">{fmtHours(r.minutes)}</td>
                        <td className="py-2 pr-4">
                          {r.billable ? (
                            <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                              {r.hourly_rate ? `$${r.hourly_rate}/h` : 'Yes'}
                            </Badge>
                          ) : (
                            <Badge variant="secondary">No</Badge>
                          )}
                        </td>
                        <td className="py-2 text-muted-foreground text-xs">
                          {safeFormat(r.logged_at, 'MMM d, yyyy')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ── OKR Dashboard tab ─────────────────────────────────────────────────────────

function OkrTab() {
  const { apiRequest } = useApiClient();
  const { data, isLoading } = useQuery<{
    goals: {
      id: string; title: string; status: string; due_date: string | null; progress: number;
      key_results: { id: string; title: string; current_value: number; target_value: number; unit: string }[];
    }[];
    summary: { total: number; on_track: number; at_risk: number; completed: number };
  }>({
    queryKey: ['analytics', 'okr'],
    queryFn: () => apiRequest('GET', '/api/analytics/okr'),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;

  const goals = data?.goals ?? [];
  const summary = data?.summary ?? { total: 0, on_track: 0, at_risk: 0, completed: 0 };

  const statusColors: Record<string, string> = {
    active: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-4">
        {[
          { label: 'Total goals',   value: summary.total,     color: '' },
          { label: 'On track (≥70%)', value: summary.on_track, color: 'text-green-600' },
          { label: 'At risk (<70%)',  value: summary.at_risk,   color: 'text-orange-500' },
          { label: 'Completed',     value: summary.completed, color: 'text-muted-foreground' },
        ].map(({ label, value, color }) => (
          <Card key={label} className="flex-1">
            <CardContent className="pt-6">
              <div className={`text-2xl font-bold ${color}`}>{value}</div>
              <div className="text-sm text-muted-foreground">{label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {goals.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No goals yet. Create goals to track OKR progress.
        </div>
      ) : (
        <div className="space-y-4">
          {goals.map((g) => (
            <Card key={g.id}>
              <CardContent className="pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{g.title}</span>
                    <Badge className={`${statusColors[g.status] ?? ''} hover:opacity-90`}>
                      {g.status}
                    </Badge>
                  </div>
                  <span className="text-sm font-medium">{g.progress}%</span>
                </div>
                <Progress value={g.progress} className="h-2" />
                {g.key_results.length > 0 && (
                  <div className="space-y-1 pt-1">
                    {g.key_results.map((kr) => {
                      const cur = kr.current_value ?? 0;
                      const tgt = kr.target_value ?? 0;
                      const pct = tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : 0;
                      return (
                        <div key={kr.id} className="flex items-center gap-3 text-sm text-muted-foreground">
                          <span className="flex-1">↳ {kr.title}</span>
                          <span>{kr.current_value} / {kr.target_value} {kr.unit}</span>
                          <span className="w-16 text-right">{pct}%</span>
                        </div>
                      );
                    })}
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

// ── Capacity tab (also lives on the Workload page — same query, consolidated here) ──────────

interface CapacityRow {
  user_clerk_id: string;
  assigned_points: number;
  task_count: number;
  capacity_points: number;
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

function CapacityEditor({
  current, onSave,
}: { current: number; onSave: (pts: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(current));
  const parsed = parseCapacity(val);
  const save = () => {
    if (parsed === null) return;
    onSave(parsed);
    setEditing(false);
  };

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
        type="number" min={0} max={MAX_CAPACITY}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        className={cn('h-6 w-20 text-xs', parsed === null && 'border-destructive')}
        title={parsed === null ? `Enter a whole number from 0 to ${MAX_CAPACITY}` : undefined}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button size="icon" variant="ghost" className="h-6 w-6" disabled={parsed === null}
        onClick={save}>
        <Check className="h-3 w-3 text-green-600" />
      </Button>
      <Button size="icon" variant="ghost" className="h-6 w-6"
        onClick={() => setEditing(false)}>
        <X className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );
}

function CapacityTab() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isAdmin = useIsAdmin();
  const { members, isLoading: membersLoading } = useMembers();

  const [sprintId, setSprintId] = useState<string>('');

  const { data: sprints = [] } = useQuery<{ id: string; name: string; status: string }[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
    staleTime: 60_000,
  });

  // Under the ['/api/tasks', ...] prefix so task mutations refresh it too.
  const capacityQueryKey = ['/api/tasks', 'capacity', sprintId || 'active'];
  const { data: capacityRows = [], isLoading: capLoading } = useQuery<CapacityRow[]>({
    queryKey: capacityQueryKey,
    queryFn: () => apiRequest('GET', `/api/tasks/capacity${sprintId ? `?sprint_id=${sprintId}` : ''}`),
    staleTime: 60_000,
  });

  // Edit the value being DISPLAYED: with a sprint selected that's the sprint override; on the
  // "Active sprint" view it's the active sprint's override when one exists (row.is_override),
  // otherwise the member's workspace default. Previously the active view always wrote the
  // default, so editing a value that came from an override appeared to do nothing.
  const saveCapacity = useMutation({
    mutationFn: ({ memberId, pts, overrideSprintId }: { memberId: string; pts: number; overrideSprintId: string | null }) =>
      apiRequest('PUT', `/api/tasks/capacity/${memberId}`, {
        capacity_points: Math.min(MAX_CAPACITY, Math.max(0, pts)),
        ...(overrideSprintId ? { sprint_id: overrideSprintId } : {}),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', 'capacity'] });
      toast({ title: vars.overrideSprintId ? 'Capacity override set for this sprint' : 'Default capacity updated' });
    },
    onError: (err: Error) => toast({ title: 'Failed to update capacity', description: err.message, variant: 'destructive' }),
  });

  const memberMap = Object.fromEntries(members.map((m) => [m.clerk_user_id, m]));

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <p className="text-xs text-muted-foreground flex-1">
          Story points assigned {sprintId ? 'in the selected sprint' : 'in the active sprint'} vs each
          member's configured capacity.
          {isAdmin && ' Click the pencil to adjust a member\'s capacity.'}
        </p>
        {sprints.length > 0 && (
          <Select value={sprintId || '__active__'} onValueChange={(v) => setSprintId(v === '__active__' ? '' : v)}>
            <SelectTrigger className="h-8 w-48 text-xs shrink-0">
              <SelectValue placeholder="Active sprint" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__active__">Active sprint</SelectItem>
              {sprints.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {sprintId && (
        <p className="text-[11px] text-muted-foreground -mt-2 mb-3">
          Editing capacity here sets an override for this sprint only — it won't change the member's default.
        </p>
      )}
      {capLoading || membersLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : capacityRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Gauge className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No {sprintId ? 'assignments in this sprint' : 'active sprint assignments'}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Assign tasks with story points to {sprintId ? 'this' : 'an active'} sprint to see capacity.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {capacityRows.map((row) => {
            const member = memberMap[row.user_clerk_id];
            const displayName = member?.display_name ?? 'Former member';
            const overrideSprintId = sprintId || (row.is_override ? row.sprint_id ?? null : null);
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
                        <div className="flex items-center gap-2">
                          <CapacityEditor
                            current={row.capacity_points}
                            onSave={(pts) => saveCapacity.mutate({ memberId: row.user_clerk_id, pts, overrideSprintId })}
                          />
                          {row.is_override && <span className="text-[10px] text-muted-foreground">(sprint override)</span>}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {row.capacity_points} pts capacity{row.is_override ? ' (sprint override)' : ''}
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
                  <p className="text-xs text-muted-foreground">
                    {row.task_count} task{row.task_count !== 1 ? 's' : ''} in {sprintId ? 'selected' : 'active'} sprint
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Analytics() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground text-sm mt-1">Sprint velocity, time tracking, and OKR progress</p>
      </div>

      <Tabs defaultValue="velocity">
        <TabsList>
          <TabsTrigger value="velocity">Sprint Velocity</TabsTrigger>
          <TabsTrigger value="time">Time Report</TabsTrigger>
          <TabsTrigger value="okr">OKR Dashboard</TabsTrigger>
          <TabsTrigger value="capacity">Capacity</TabsTrigger>
        </TabsList>
        <TabsContent value="velocity" className="mt-6"><VelocityTab /></TabsContent>
        <TabsContent value="time"     className="mt-6"><TimeReportTab /></TabsContent>
        <TabsContent value="okr"      className="mt-6"><OkrTab /></TabsContent>
        <TabsContent value="capacity" className="mt-6"><CapacityTab /></TabsContent>
      </Tabs>
    </div>
  );
}
