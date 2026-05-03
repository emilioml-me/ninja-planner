import { useQuery } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { format, isBefore, isToday, startOfDay } from 'date-fns';
import { Link } from 'wouter';
import { useApiClient } from '@/lib/api';
import { useIntegrationsSummary } from '@/hooks/use-integrations';
import { StatCard } from '@/components/StatCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CheckSquare,
  TrendingUp,
  Map,
  ClipboardList,
  Clock,
  Calendar,
  ArrowRight,
  Trophy,
  AlertTriangle,
  Target,
  Lightbulb,
  Hammer,
  Rocket,
  Archive,
  Users,
  HeadphonesIcon,
  CalendarDays,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types (minimal, inlined) ─────────────────────────────────────────────────

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
}

interface RevenueTarget {
  id: string;
  period_type: string;
  period_start: string;
  target_amount: string;
  actual_amount: string;
}

interface RoadmapItem {
  id: string;
  title: string;
  status: string;
  phase: string | null;
}

interface WeeklyReview {
  id: string;
  week_start: string;
  wins: string | null;
  focus_next: string | null;
  health_score: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function fmt(val: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(val);
}

function healthColor(score: number) {
  if (score >= 4) return 'bg-green-500 border-green-500';
  if (score >= 3) return 'bg-yellow-500 border-yellow-500';
  return 'bg-red-500 border-red-500';
}

function HealthDots({ score }: { score: number }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className={cn(
            'h-2.5 w-2.5 rounded-full border',
            i <= score ? healthColor(score) : 'bg-transparent border-muted-foreground/30',
          )}
        />
      ))}
    </div>
  );
}

const priorityBadge: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
  high:   'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-400',
  medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400',
  low:    'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400',
};

const roadmapStatuses = [
  { id: 'idea',     label: 'Idea',     icon: Lightbulb, color: 'text-purple-500' },
  { id: 'building', label: 'Building', icon: Hammer,    color: 'text-blue-500'   },
  { id: 'live',     label: 'Live',     icon: Rocket,    color: 'text-green-500'  },
  { id: 'archived', label: 'Archived', icon: Archive,   color: 'text-gray-400'   },
];

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { apiRequest } = useApiClient();
  const { user } = useUser();
  const { data: integrations } = useIntegrationsSummary();

  const { data: tasks = [],   isLoading: tLoading } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => apiRequest<Task[]>('GET', '/api/tasks'),
  });

  const { data: revenue = [], isLoading: rLoading } = useQuery<RevenueTarget[]>({
    queryKey: ['/api/revenue'],
    queryFn: () => apiRequest<RevenueTarget[]>('GET', '/api/revenue'),
  });

  const { data: roadmap = [], isLoading: rmLoading } = useQuery<RoadmapItem[]>({
    queryKey: ['/api/roadmap'],
    queryFn: () => apiRequest<RoadmapItem[]>('GET', '/api/roadmap'),
  });

  const { data: reviews = [], isLoading: rvLoading } = useQuery<WeeklyReview[]>({
    queryKey: ['/api/reviews'],
    queryFn: () => apiRequest<WeeklyReview[]>('GET', '/api/reviews'),
  });

  // ── Derived: tasks ──────────────────────────────────────────────────────────

  const now = new Date();
  const todayStart = startOfDay(now);

  const needsAttention = tasks.filter((t) => {
    if (t.status === 'done' || !t.due_date) return false;
    const due = new Date(t.due_date + 'T23:59:59');
    return due <= now; // overdue OR end of today
  }).sort((a, b) => new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime());

  const overdueCount  = needsAttention.filter((t) => isBefore(new Date(t.due_date! + 'T23:59:59'), todayStart)).length;
  const dueTodayCount = needsAttention.filter((t) => isToday(new Date(t.due_date!))).length;
  const inProgress    = tasks.filter((t) => t.status === 'in_progress').length;

  // ── Derived: revenue (current month) ───────────────────────────────────────

  const thisMonthPrefix = format(now, 'yyyy-MM');
  const monthTarget = revenue.find(
    (r) => r.period_type === 'monthly' && r.period_start.startsWith(thisMonthPrefix),
  ) ?? null;

  const monthPct = monthTarget
    ? Math.min(100, Math.round((Number(monthTarget.actual_amount) / Number(monthTarget.target_amount)) * 100))
    : null;

  // ── Derived: roadmap ────────────────────────────────────────────────────────

  const byStatus = (s: string) => roadmap.filter((i) => i.status === s);
  const building = byStatus('building').slice(0, 4);

  // ── Derived: last review ────────────────────────────────────────────────────

  const lastReview = [...reviews]
    .sort((a, b) => new Date(b.week_start).getTime() - new Date(a.week_start).getTime())[0] ?? null;

  const isLoading = tLoading || rLoading || rmLoading || rvLoading;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Page header */}
      <div className="px-6 py-5 border-b shrink-0">
        <h1 className="text-xl font-semibold">
          {greeting()}{user?.firstName ? `, ${user.firstName}` : ''}.
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {format(now, 'EEEE, MMMM d')} — here's what needs your attention.
        </p>
      </div>

      <div className="flex-1 p-6 space-y-6">

        {/* ── Stat cards ──────────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1,2,3,4].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard
              label="Overdue"
              value={String(overdueCount)}
              icon={<Clock className={cn('h-4 w-4', overdueCount > 0 ? 'text-destructive' : '')} />}
            />
            <StatCard
              label="Due Today"
              value={String(dueTodayCount)}
              icon={<Calendar className="h-4 w-4" />}
            />
            <StatCard
              label={`Revenue — ${format(now, 'MMM')}`}
              value={monthPct !== null ? `${monthPct}%` : '—'}
              icon={<TrendingUp className="h-4 w-4" />}
            />
            <StatCard
              label="In Progress"
              value={String(inProgress)}
              icon={<CheckSquare className="h-4 w-4" />}
            />
          </div>
        )}

        {/* ── Integration stat cards (only shown when configured) ─────── */}
        {integrations && (
          <>
            {integrations.crm.configured && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                  label="Active Clients"
                  value={integrations.crm.data ? String(integrations.crm.data.activeClients) : '—'}
                  icon={<Users className="h-4 w-4 text-blue-500" />}
                />
                <StatCard
                  label="MRR"
                  value={integrations.crm.data ? `$${integrations.crm.data.totalMRR.toLocaleString()}` : '—'}
                  icon={<TrendingUp className="h-4 w-4 text-blue-500" />}
                />
                {integrations.helpdesk.configured && (
                  <StatCard
                    label="Open Tickets"
                    value={integrations.helpdesk.data ? String(integrations.helpdesk.data.openTickets) : '—'}
                    icon={<HeadphonesIcon className={cn('h-4 w-4', integrations.helpdesk.data?.urgentTickets ? 'text-destructive' : 'text-orange-500')} />}
                  />
                )}
                {integrations.schedule.configured && (
                  <StatCard
                    label="Appointments Today"
                    value={integrations.schedule.data ? String(integrations.schedule.data.todayCount) : '—'}
                    icon={<CalendarDays className="h-4 w-4 text-purple-500" />}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* ── Middle row ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">

          {/* Needs attention */}
          <Card className="lg:col-span-3">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-orange-500" />
                Needs Attention
                {needsAttention.length > 0 && (
                  <Badge variant="secondary" className="ml-auto text-xs">{needsAttention.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tLoading ? (
                <div className="space-y-2">
                  {[1,2,3].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
                </div>
              ) : needsAttention.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                  <CheckSquare className="h-8 w-8 text-green-500 opacity-70" />
                  <p className="text-sm text-muted-foreground">All caught up — nothing overdue.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {needsAttention.slice(0, 7).map((task) => {
                    const isOverdue = isBefore(new Date(task.due_date! + 'T23:59:59'), todayStart);
                    return (
                      <div
                        key={task.id}
                        className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted/50 transition-colors"
                      >
                        <div className={cn(
                          'h-1.5 w-1.5 rounded-full shrink-0',
                          isOverdue ? 'bg-destructive' : 'bg-yellow-500',
                        )} />
                        <span className="flex-1 text-sm truncate">{task.title}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {task.priority && task.priority !== 'medium' && (
                            <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', priorityBadge[task.priority])}>
                              {task.priority}
                            </span>
                          )}
                          <span className={cn(
                            'text-xs',
                            isOverdue ? 'text-destructive font-medium' : 'text-muted-foreground',
                          )}>
                            {isOverdue
                              ? `Due ${format(new Date(task.due_date!), 'MMM d')}`
                              : 'Due today'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {needsAttention.length > 7 && (
                    <p className="text-xs text-muted-foreground pl-2 pt-1">
                      +{needsAttention.length - 7} more
                    </p>
                  )}
                </div>
              )}
              <Separator className="mt-4 mb-3" />
              <Link href="/tasks">
                <a className="text-xs text-primary hover:underline flex items-center gap-1">
                  Go to task board <ArrowRight className="h-3 w-3" />
                </a>
              </Link>
            </CardContent>
          </Card>

          {/* Right column: revenue + review */}
          <div className="lg:col-span-2 flex flex-col gap-4">

            {/* Revenue this month */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  Revenue — {format(now, 'MMMM')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {rLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : monthTarget ? (
                  <div className="space-y-3">
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-2xl font-bold">{fmt(Number(monthTarget.actual_amount))}</p>
                        <p className="text-xs text-muted-foreground">of {fmt(Number(monthTarget.target_amount))} target</p>
                      </div>
                      <span className={cn(
                        'text-sm font-semibold',
                        monthPct! >= 100 ? 'text-green-600' : monthPct! >= 70 ? 'text-yellow-600' : 'text-destructive',
                      )}>
                        {monthPct}%
                      </span>
                    </div>
                    <Progress value={monthPct!} className="h-2" />
                  </div>
                ) : (
                  <div className="py-3 text-center">
                    <p className="text-sm text-muted-foreground">No target set for {format(now, 'MMMM')}.</p>
                    <Link href="/revenue">
                      <a className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1">
                        Add one <ArrowRight className="h-3 w-3" />
                      </a>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Last weekly review */}
            <Card className="flex-1">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <ClipboardList className="h-4 w-4 text-primary" />
                  Last Review
                </CardTitle>
              </CardHeader>
              <CardContent>
                {rvLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : lastReview ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        Week of {format(new Date(lastReview.week_start + 'T00:00:00'), 'MMM d, yyyy')}
                      </p>
                      {lastReview.health_score && <HealthDots score={lastReview.health_score} />}
                    </div>
                    {lastReview.wins && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                          <Trophy className="h-3 w-3 text-yellow-500" /> Wins
                        </p>
                        <p className="text-xs text-foreground line-clamp-2">{lastReview.wins}</p>
                      </div>
                    )}
                    {lastReview.focus_next && (
                      <div className="space-y-0.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                          <Target className="h-3 w-3 text-blue-500" /> Focus
                        </p>
                        <p className="text-xs text-foreground line-clamp-2">{lastReview.focus_next}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-3 text-center">
                    <p className="text-sm text-muted-foreground">No reviews yet.</p>
                    <Link href="/reviews">
                      <a className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1">
                        Start this week's review <ArrowRight className="h-3 w-3" />
                      </a>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* ── Roadmap overview ────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Map className="h-4 w-4 text-primary" />
              Roadmap
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rmLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <div className="space-y-4">
                {/* Status counts */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {roadmapStatuses.map(({ id, label, icon: Icon, color }) => (
                    <div key={id} className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
                      <Icon className={cn('h-4 w-4 shrink-0', color)} />
                      <div>
                        <p className="text-xs text-muted-foreground">{label}</p>
                        <p className="text-lg font-semibold leading-tight">{byStatus(id).length}</p>
                      </div>
                    </div>
                  ))}
                </div>

                {/* What's building */}
                {building.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
                        <Hammer className="h-3 w-3 text-blue-500" /> Currently building
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {building.map((item) => (
                          <Badge key={item.id} variant="secondary" className="text-xs">
                            {item.title}
                            {item.phase && <span className="ml-1 text-muted-foreground">· {item.phase}</span>}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            <Separator className="mt-4 mb-3" />
            <Link href="/roadmap">
              <a className="text-xs text-primary hover:underline flex items-center gap-1">
                Open roadmap <ArrowRight className="h-3 w-3" />
              </a>
            </Link>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
