import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { useMembers } from '@/hooks/use-members';
import { useMyRole } from '@/hooks/use-is-admin';
import { useToast } from '@/hooks/use-toast';
import { QueryError } from '@/components/QueryError';
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

interface VelocityRow {
  id: string; name: string; start_date: string; end_date: string;
  /** Committed points: the snapshot taken when the sprint started, when one exists. */
  total_points: number | string;
  completed_points: number | string;
  /** False for sprints started before snapshots: total_points is then the points left at close. */
  committed_snapshot?: boolean;
}

/** Short axis label; the full name is shown in the tooltip. */
function shortLabel(name: string): string {
  return name.length > 14 ? name.slice(0, 12) + '…' : name;
}

function VelocityTab() {
  const { apiRequest } = useApiClient();
  const { data, isLoading, isError, error, refetch } = useQuery<VelocityRow[]>({
    queryKey: ['analytics', 'velocity'],
    queryFn: () => apiRequest('GET', '/api/analytics/velocity'),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError && !data) return <QueryError error={error} onRetry={() => refetch()} />;
  const sprints = data ?? [];
  if (!sprints.length) {
    return (
      <div className="text-center py-20 text-muted-foreground">
        No completed sprints yet. Complete a sprint to see velocity data.
      </div>
    );
  }

  // "Committed" is the snapshot taken when the sprint started; older sprints without one fall
  // back to the points that were still in the sprint when it closed.
  const anyWithoutSnapshot = sprints.some((s) => s.committed_snapshot === false);
  // Keyed by index so two sprints whose names truncate to the same label stay separate bars.
  const chartData = sprints.map((s, i) => ({
    key: String(i),
    label: shortLabel(s.name),
    fullName: s.committed_snapshot === false ? `${s.name} (committed approx.)` : s.name,
    'Committed': Number(s.total_points) || 0,
    'Completed': Number(s.completed_points) || 0,
  }));
  const tickLabel = (k: string) => chartData[Number(k)]?.label ?? '';
  const tooltipLabel = (k: unknown) => chartData[Number(k)]?.fullName ?? '';

  const avgVelocity = Math.round(
    chartData.reduce((s, r) => s + r.Completed, 0) / chartData.length,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        {[
          { label: 'Avg points / sprint', value: avgVelocity },
          { label: 'Sprints tracked', value: chartData.length },
          { label: 'Last sprint velocity', value: chartData[chartData.length - 1]?.Completed ?? 0 },
        ].map(({ label, value }) => (
          <Card key={label} className="flex-1 min-w-[10rem]">
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
              <XAxis dataKey="key" tickFormatter={tickLabel} tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip labelFormatter={tooltipLabel} />
              <Legend />
              <Bar dataKey="Committed" fill="#a1a1aa" radius={[2,2,0,0]} />
              <Bar dataKey="Completed" fill="#f97316" radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
          {anyWithoutSnapshot && (
            <p className="text-xs text-muted-foreground mt-2">
              Committed = points in the sprint when it started. Sprints marked "approx." in the
              tooltip were started before this was recorded and show the points still in the
              sprint when it closed.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Velocity Trend</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="key" tickFormatter={tickLabel} tick={{ fontSize: 12 }} />
              <YAxis />
              <Tooltip labelFormatter={tooltipLabel} />
              <Line type="monotone" dataKey="Completed" stroke="#f97316" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Time Report tab ───────────────────────────────────────────────────────────

// Time logs carry no currency, so amounts are shown as plain numbers (same units as the rates).
const amountFormat = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAmount = (v: number | string | null | undefined) => amountFormat.format(Number(v) || 0);

function TimeReportTab() {
  const { apiRequest } = useApiClient();
  const { members, displayName } = useMembers();
  const [from, setFrom] = useState('');
  const [to, setTo]     = useState('');
  const [member, setMember] = useState('');

  const rangeInvalid = !!from && !!to && from > to;

  const { data, isLoading, isError, error, refetch } = useQuery<{
    rows: {
      id: string; task_title: string; minutes: number; billable: boolean;
      hourly_rate: number | string | null; user_clerk_id: string; sprint_name: string | null; logged_at: string;
    }[];
    summary: { total_minutes: number; billable_minutes: number; billable_value: number | string };
    truncated?: boolean;
  }>({
    queryKey: ['analytics', 'time-report', from, to, member],
    queryFn: () => {
      const p = new URLSearchParams();
      if (from)   p.set('from', from);
      if (to)     p.set('to', to);
      if (member) p.set('member', member);
      return apiRequest('GET', `/api/analytics/time-report?${p}`);
    },
    // An inverted range is a guaranteed 400; don't send it (the inline message explains why).
    enabled: !rangeInvalid,
  });

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? { total_minutes: 0, billable_minutes: 0, billable_value: 0 };
  const truncated = data?.truncated ?? false;
  const fmtHours = (m: number) => {
    const n = Number(m) || 0;
    return `${Math.floor(n / 60)}h ${n % 60}m`;
  };
  // Names for departed members fall back to the raw id in displayName(); say so instead.
  const loggedBy = (clerkId: string) => {
    const name = displayName(clerkId);
    return name && name !== clerkId ? name : 'Former member';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <label htmlFor="time-report-from" className="text-xs text-muted-foreground">From</label>
          <input id="time-report-from" type="date" value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
        </div>
        <div className="space-y-1">
          <label htmlFor="time-report-to" className="text-xs text-muted-foreground">To</label>
          <input id="time-report-to" type="date" value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border border-input rounded px-2 py-1 text-sm bg-background text-foreground" />
        </div>
        <div className="space-y-1">
          <label htmlFor="time-report-member" className="text-xs text-muted-foreground block">Member</label>
          <Select value={member || '__all__'} onValueChange={(v) => setMember(v === '__all__' ? '' : v)}>
            <SelectTrigger id="time-report-member" className="h-8 w-48 text-sm">
              <SelectValue placeholder="All members" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All members</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.clerk_user_id} value={m.clerk_user_id}>{m.display_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(from || to || member) && (
          <Button variant="ghost" size="sm" className="h-8" onClick={() => { setFrom(''); setTo(''); setMember(''); }}>
            Clear
          </Button>
        )}
      </div>
      {rangeInvalid && (
        <p className="text-xs text-destructive" role="alert">"From" must be on or before "To".</p>
      )}
      {truncated && !rangeInvalid && (
        <p className="flex items-center gap-1.5 text-xs text-yellow-700 dark:text-yellow-400">
          <AlertTriangle className="h-3.5 w-3.5" />
          Only the 1000 most recent entries are listed below; the totals include every entry in the range.
        </p>
      )}

      {rangeInvalid ? null : isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : isError && !data ? (
        <QueryError error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            {[
              { label: 'Total logged',   value: fmtHours(summary.total_minutes) },
              { label: 'Billable',       value: fmtHours(summary.billable_minutes) },
              { label: 'Billable value (hours x rate)', value: fmtAmount(summary.billable_value) },
            ].map(({ label, value }) => (
              <Card key={label} className="flex-1 min-w-[10rem]">
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
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground text-left">
                        <th className="py-2 pr-4">Task</th>
                        <th className="py-2 pr-4">Logged by</th>
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
                          <td className="py-2 pr-4 text-muted-foreground">{loggedBy(r.user_clerk_id)}</td>
                          <td className="py-2 pr-4 text-muted-foreground">{r.sprint_name ?? '—'}</td>
                          <td className="py-2 pr-4 whitespace-nowrap">{fmtHours(r.minutes)}</td>
                          <td className="py-2 pr-4">
                            {r.billable ? (
                              <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                                {r.hourly_rate != null && Number(r.hourly_rate) > 0 ? `${fmtAmount(r.hourly_rate)}/h` : 'Yes'}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">No</Badge>
                            )}
                          </td>
                          <td className="py-2 text-muted-foreground text-xs whitespace-nowrap">
                            {safeFormat(r.logged_at, 'MMM d, yyyy')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
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
  const { data, isLoading, isError, error, refetch } = useQuery<{
    goals: {
      id: string; title: string; status: string; due_date: string | null; progress: number;
      // NUMERIC columns arrive as strings.
      key_results: { id: string; title: string; current_value: number | string | null; target_value: number | string | null; unit: string | null }[];
    }[];
    summary: { total: number; on_track: number; at_risk: number; completed: number };
  }>({
    queryKey: ['analytics', 'okr'],
    queryFn: () => apiRequest('GET', '/api/analytics/okr'),
  });

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (isError && !data) return <QueryError error={error} onRetry={() => refetch()} />;

  const goals = data?.goals ?? [];
  const summary = data?.summary ?? { total: 0, on_track: 0, at_risk: 0, completed: 0 };

  const statusColors: Record<string, string> = {
    active: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        {[
          { label: 'Total goals',   value: summary.total,     color: '' },
          { label: 'On track (≥70%)', value: summary.on_track, color: 'text-green-600' },
          { label: 'At risk (<70%)',  value: summary.at_risk,   color: 'text-orange-500' },
          { label: 'Completed',     value: summary.completed, color: 'text-muted-foreground' },
        ].map(({ label, value, color }) => (
          <Card key={label} className="flex-1 min-w-[10rem]">
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
                  <span className="text-sm font-medium">{Math.max(0, Math.min(100, Number(g.progress) || 0))}%</span>
                </div>
                <Progress value={Math.max(0, Math.min(100, Number(g.progress) || 0))} className="h-2" />
                {g.key_results.length > 0 && (
                  <div className="space-y-1 pt-1">
                    {g.key_results.map((kr) => {
                      const cur = Number(kr.current_value) || 0;
                      const tgt = Number(kr.target_value) || 0;
                      const pct = tgt > 0 ? Math.max(0, Math.min(100, Math.round((cur / tgt) * 100))) : 0;
                      return (
                        <div key={kr.id} className="flex items-center gap-3 text-sm text-muted-foreground">
                          <span className="flex-1 min-w-0 truncate">↳ {kr.title}</span>
                          <span className="shrink-0">{cur} / {tgt} {kr.unit ?? ''}</span>
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

// Point sums can arrive as NUMERIC strings; always read them through Number().
interface CapacityRow {
  user_clerk_id: string;
  assigned_points: number | string;
  /** Points of not-done tasks in the sprint. */
  remaining_points?: number | string;
  task_count: number | string;
  capacity_points: number | string;
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

function CapacityTab() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isAdmin } = useMyRole();
  const { members, isLoading: membersLoading } = useMembers();

  const [sprintId, setSprintId] = useState<string>('');

  const { data: sprints = [] } = useQuery<{ id: string; name: string; status: string }[]>({
    queryKey: ['/api/sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
    staleTime: 60_000,
  });

  // Under the ['/api/tasks', ...] prefix so task mutations refresh it too.
  const capacityQueryKey = ['/api/tasks', 'capacity', sprintId || 'active'];
  const {
    data: capacityData, isLoading: capLoading, isError: capIsError, error: capError, refetch: refetchCap,
  } = useQuery<CapacityRow[]>({
    queryKey: capacityQueryKey,
    queryFn: () => apiRequest('GET', `/api/tasks/capacity${sprintId ? `?sprint_id=${encodeURIComponent(sprintId)}` : ''}`),
    staleTime: 60_000,
  });
  const capacityRows = capacityData ?? [];
  // The endpoint lists every member; sprint_id is null on all rows when no sprint is active.
  const noActiveSprint = !sprintId && capacityRows.length > 0 && capacityRows.every((r) => !r.sprint_id);

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
    // Failures are shown inline by CapacityEditor (which awaits mutateAsync).
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
            <SelectTrigger className="h-8 w-48 text-xs shrink-0" aria-label="Sprint">
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
      ) : capIsError && !capacityData ? (
        <QueryError error={capError} onRetry={() => refetchCap()} />
      ) : capacityRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Gauge className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium">No members to show</p>
        </div>
      ) : (
        <div className="space-y-4">
          {noActiveSprint && (
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground flex items-center gap-2">
              <Gauge className="h-4 w-4 shrink-0" />
              No active sprint. Showing each member's default capacity; start a sprint (or pick one above) to see assigned points.
            </div>
          )}
          {capacityRows.map((row) => {
            const member = memberMap[row.user_clerk_id];
            const displayName = member?.display_name ?? 'Former member';
            const overrideSprintId = sprintId || (row.is_override ? row.sprint_id ?? null : null);
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
                            onSave={(pts) => saveCapacity.mutateAsync({ memberId: row.user_clerk_id, pts, overrideSprintId })}
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
                  <p className="text-xs text-muted-foreground">
                    {taskCount} task{taskCount !== 1 ? 's' : ''} in {sprintId ? 'selected' : 'active'} sprint
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
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="velocity">Sprint Velocity</TabsTrigger>
            <TabsTrigger value="time">Time Report</TabsTrigger>
            <TabsTrigger value="okr">OKR Dashboard</TabsTrigger>
            <TabsTrigger value="capacity">Capacity</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="velocity" className="mt-6"><VelocityTab /></TabsContent>
        <TabsContent value="time"     className="mt-6"><TimeReportTab /></TabsContent>
        <TabsContent value="okr"      className="mt-6"><OkrTab /></TabsContent>
        <TabsContent value="capacity" className="mt-6"><CapacityTab /></TabsContent>
      </Tabs>
    </div>
  );
}
