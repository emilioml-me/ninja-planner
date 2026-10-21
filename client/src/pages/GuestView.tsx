import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, Briefcase } from 'lucide-react';
import { SeoHead } from '@/components/SeoHead';
import { safeFormat } from '@/lib/utils';
import { baseHeaders } from '@/lib/api';

// Row caps applied by guestView.ts; hitting one means the list is partial.
const CAPS = { tasks: 500, roadmap: 200, goals: 200, sprints: 20, epics: 200, changelog: 100, budgets: 200 } as const;

type ErrorKind = 'not_found' | 'rate_limited' | 'other';

const fmtDate = (d: string | null | undefined) => safeFormat(d ?? null, 'MMM d, yyyy', d ?? '');

function CapNote({ count, cap, noun, recent }: { count: number; cap: number; noun: string; recent?: boolean }) {
  if (count < cap) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Showing the {recent ? 'most recent' : 'first'} {cap} {noun}; there may be more.
    </p>
  );
}

// Mirrors the (deliberately minimal) guestView.ts payload — no internal ids, tags or free text.
interface GuestData {
  label: string;
  scopes: string[];
  tasks?: { id: string; title: string; status: string; priority: string; due_date: string | null }[];
  roadmap?: { id: string; title: string; phase: string | null; status: string }[];
  goals?: { id: string; title: string; status: string; due_date: string | null }[];
  sprints?: { id: string; name: string; status: string; start_date: string | null; end_date: string | null }[];
  epics?: { id: string; title: string; status: string; color: string; total_tasks: number; done_tasks: number }[];
  changelog?: { id: string; title: string; priority: string; completed_at: string; sprint_name: string | null; epic_title: string | null }[];
  budgets?: { id: string; name: string; target_amount: string; currency: string; period_start: string | null; period_end: string | null; status: string; actual_amount: string; time_cost?: string | number | null }[];
}

const STATUS_COLORS: Record<string, string> = {
  todo: 'bg-gray-100 text-gray-600',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
  blocked: 'bg-red-100 text-red-700',
  active: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  planning: 'bg-yellow-100 text-yellow-700',
  idea: 'bg-gray-100 text-gray-600',
  building: 'bg-blue-100 text-blue-700',
  live: 'bg-green-100 text-green-700',
  archived: 'bg-gray-100 text-gray-400',
};

interface GuestViewProps { token: string }

export default function GuestView({ token }: GuestViewProps) {
  const [data,    setData]    = useState<GuestData | null>(null);
  const [error,   setError]   = useState<ErrorKind | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Reset per token so a previous link's error (or data) never sticks to a new one.
    setLoading(true);
    setError(null);
    setData(null);
    fetch(`/public/g/${encodeURIComponent(token)}`, { signal: controller.signal, headers: baseHeaders() })
      .then(async (r) => {
        if (!r.ok) {
          const kind: ErrorKind = r.status === 404 ? 'not_found' : r.status === 429 ? 'rate_limited' : 'other';
          throw Object.assign(new Error(`HTTP ${r.status}`), { kind });
        }
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: Error & { kind?: ErrorKind }) => {
        if (controller.signal.aborted) return;
        setError(e.kind ?? 'other'); setLoading(false);
      });
    return () => controller.abort();
  }, [token, attempt]);

  // Guest links must never be indexed.
  const seo = <SeoHead title={data ? `${data.label} (guest view)` : 'Guest view'} description="Shared project view." noIndex />;

  if (loading) {
    return (
      <div className="min-h-screen p-8">
        {seo}
        <Skeleton className="h-8 w-48 mb-4" />
        <div className="space-y-3">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      </div>
    );
  }

  if (error || !data) {
    const notFound = error === 'not_found';
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        {seo}
        <div className="text-center space-y-3">
          <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
          <p className="text-lg font-semibold">
            {notFound ? 'Link not found or expired' : "Couldn't load this page"}
          </p>
          <p className="text-muted-foreground text-sm">
            {notFound
              ? 'This guest link may have been revoked or expired.'
              : error === 'rate_limited'
                ? 'Too many requests right now. Please wait a minute and try again.'
                : 'Something went wrong. Please check your connection and try again.'}
          </p>
          {!notFound && (
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  const tabs = data.scopes
    .filter((s) => ['tasks:read','roadmap:read','goals:read','sprints:read','epics:read','changelog:read','budgets:read'].includes(s))
    .map((s) => s.replace(':read',''));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center gap-3">
        <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center">
          <Briefcase className="h-4 w-4 text-primary-foreground" />
        </div>
        <div>
          <span className="font-semibold text-sm">Ninja Planner</span>
          <span className="text-muted-foreground text-xs ml-2">· {data.label}</span>
        </div>
        <Badge variant="secondary" className="ml-auto text-xs">Guest View</Badge>
      </div>

      {seo}
      <div className="p-6">
        <Tabs defaultValue={tabs[0]}>
          <div className="overflow-x-auto">
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t} value={t} className="capitalize">{t}</TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Tasks */}
          {data.tasks && (
            <TabsContent value="tasks" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.tasks.length} cap={CAPS.tasks} noun="tasks" />
                {data.tasks.length === 0
                  ? <p className="text-muted-foreground">No tasks.</p>
                  : data.tasks.map((t) => (
                    <Card key={t.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{t.title}</span>
                        <div className="flex items-center gap-2">
                          {t.due_date && (
                            <span className="text-xs text-muted-foreground">Due {fmtDate(t.due_date)}</span>
                          )}
                          <Badge className={`text-xs ${STATUS_COLORS[t.status] ?? ''} hover:opacity-90`}>
                            {t.status}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </TabsContent>
          )}

          {/* Roadmap */}
          {data.roadmap && (
            <TabsContent value="roadmap" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.roadmap.length} cap={CAPS.roadmap} noun="roadmap items" />
                {data.roadmap.length === 0
                  ? <p className="text-muted-foreground">No roadmap items.</p>
                  : data.roadmap.map((r) => (
                    <Card key={r.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium">{r.title}</span>
                          {r.phase && <span className="text-xs text-muted-foreground ml-2">{r.phase}</span>}
                        </div>
                        <Badge className={`text-xs ${STATUS_COLORS[r.status] ?? ''} hover:opacity-90`}>
                          {r.status}
                        </Badge>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </TabsContent>
          )}

          {/* Goals */}
          {data.goals && (
            <TabsContent value="goals" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.goals.length} cap={CAPS.goals} noun="goals" />
                {data.goals.length === 0
                  ? <p className="text-muted-foreground">No goals.</p>
                  : data.goals.map((g) => (
                    <Card key={g.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{g.title}</span>
                        <div className="flex items-center gap-2">
                          {g.due_date && <span className="text-xs text-muted-foreground">Due {fmtDate(g.due_date)}</span>}
                          <Badge className={`text-xs ${STATUS_COLORS[g.status] ?? ''} hover:opacity-90`}>
                            {g.status}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </TabsContent>
          )}

          {/* Sprints */}
          {data.sprints && (
            <TabsContent value="sprints" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.sprints.length} cap={CAPS.sprints} noun="sprints" recent />
                {data.sprints.length === 0
                  ? <p className="text-muted-foreground">No sprints.</p>
                  : data.sprints.map((s) => (
                    <Card key={s.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{s.name}</span>
                        <div className="flex items-center gap-2">
                          {s.start_date && s.end_date && (
                            <span className="text-xs text-muted-foreground">
                              {fmtDate(s.start_date)} → {fmtDate(s.end_date)}
                            </span>
                          )}
                          <Badge className={`text-xs ${STATUS_COLORS[s.status] ?? ''} hover:opacity-90`}>
                            {s.status}
                          </Badge>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </TabsContent>
          )}
          {/* Epics */}
          {data.epics && (
            <TabsContent value="epics" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.epics.length} cap={CAPS.epics} noun="epics" recent />
                {data.epics.length === 0
                  ? <p className="text-muted-foreground">No epics.</p>
                  : data.epics.map((e) => {
                    const total = Number(e.total_tasks) || 0;
                    const done = Number(e.done_tasks) || 0;
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                    return (
                      <Card key={e.id}>
                        <CardContent className="py-3 px-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium flex items-center gap-1.5">
                              <span className="h-2 w-2 rounded-full inline-block" style={{ backgroundColor: e.color }} />
                              {e.title}
                            </span>
                            <Badge className={`text-xs ${STATUS_COLORS[e.status] ?? ''} hover:opacity-90`}>
                              {e.status}
                            </Badge>
                          </div>
                          {total > 0 && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>{done}/{total} tasks</span>
                                <span>{pct}%</span>
                              </div>
                              <Progress value={pct} className="h-1" />
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
              </div>
            </TabsContent>
          )}
          {/* Changelog */}
          {data.changelog && (
            <TabsContent value="changelog" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.changelog.length} cap={CAPS.changelog} noun="completed tasks" recent />
                {data.changelog.length === 0
                  ? <p className="text-muted-foreground">No completed tasks in the last 30 days.</p>
                  : data.changelog.map((c) => (
                    <Card key={c.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium">{c.title}</span>
                          {(c.sprint_name || c.epic_title) && (
                            <span className="text-xs text-muted-foreground ml-2">
                              {c.sprint_name ?? c.epic_title}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {fmtDate(c.completed_at)}
                        </span>
                      </CardContent>
                    </Card>
                  ))}
              </div>
            </TabsContent>
          )}
          {/* Budgets */}
          {data.budgets && (
            <TabsContent value="budgets" className="mt-6">
              <div className="space-y-2">
                <CapNote count={data.budgets.length} cap={CAPS.budgets} noun="budgets" recent />
                {data.budgets.length === 0
                  ? <p className="text-muted-foreground">No budgets.</p>
                  : data.budgets.map((b) => {
                    // Postgres numeric columns come back as strings over JSON (no pg type-parser
                    // override in this app), so these must be coerced before .toLocaleString() —
                    // string values have no such method and would throw.
                    const actual = Number(b.actual_amount);
                    const target = Number(b.target_amount);
                    const timeCost = Number(b.time_cost ?? 0);
                    const pct = target > 0 ? Math.round((actual / target) * 100) : 0;
                    return (
                      <Card key={b.id}>
                        <CardContent className="py-3 px-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">{b.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {actual.toLocaleString()} / {target.toLocaleString()} {b.currency}
                            </span>
                          </div>
                          <Progress value={Math.min(pct, 100)} className="h-1" />
                          {timeCost > 0 && (
                            <p className="text-[10px] text-muted-foreground">
                              + {timeCost.toLocaleString()} {b.currency} in billable logged time (not counted above)
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
              </div>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
