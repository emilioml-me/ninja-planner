import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { AlertTriangle, Briefcase } from 'lucide-react';

interface GuestData {
  workspace_id: string;
  label: string;
  scopes: string[];
  tasks?: { id: string; title: string; status: string; priority: string; due_date: string | null }[];
  roadmap?: { id: string; title: string; phase: string | null; status: string }[];
  goals?: { id: string; title: string; status: string; due_date: string | null }[];
  sprints?: { id: string; name: string; status: string; start_date: string | null; end_date: string | null }[];
  epics?: { id: string; title: string; description: string | null; status: string; color: string; total_tasks: number; done_tasks: number }[];
  changelog?: { id: string; title: string; priority: string; completed_at: string; sprint_name: string | null; epic_title: string | null }[];
  budgets?: { id: string; name: string; target_amount: string; currency: string; period_start: string | null; period_end: string | null; status: string; actual_amount: string }[];
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
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/public/g/${token}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e.message); setLoading(false);
      });
    return () => controller.abort();
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen p-8">
        <Skeleton className="h-8 w-48 mb-4" />
        <div className="space-y-3">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center space-y-3">
          <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
          <p className="text-lg font-semibold">Link not found or expired</p>
          <p className="text-muted-foreground text-sm">This guest link may have been revoked or expired.</p>
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

      <div className="p-6">
        <Tabs defaultValue={tabs[0]}>
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t} className="capitalize">{t}</TabsTrigger>
            ))}
          </TabsList>

          {/* Tasks */}
          {data.tasks && (
            <TabsContent value="tasks" className="mt-6">
              <div className="space-y-2">
                {data.tasks.length === 0
                  ? <p className="text-muted-foreground">No tasks.</p>
                  : data.tasks.map((t) => (
                    <Card key={t.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{t.title}</span>
                        <div className="flex items-center gap-2">
                          {t.due_date && (
                            <span className="text-xs text-muted-foreground">{t.due_date}</span>
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
                {data.goals.length === 0
                  ? <p className="text-muted-foreground">No goals.</p>
                  : data.goals.map((g) => (
                    <Card key={g.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{g.title}</span>
                        <div className="flex items-center gap-2">
                          {g.due_date && <span className="text-xs text-muted-foreground">{g.due_date}</span>}
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
                {data.sprints.length === 0
                  ? <p className="text-muted-foreground">No sprints.</p>
                  : data.sprints.map((s) => (
                    <Card key={s.id}>
                      <CardContent className="py-3 px-4 flex items-center justify-between">
                        <span className="text-sm font-medium">{s.name}</span>
                        <div className="flex items-center gap-2">
                          {s.start_date && s.end_date && (
                            <span className="text-xs text-muted-foreground">
                              {s.start_date} → {s.end_date}
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
                {data.epics.length === 0
                  ? <p className="text-muted-foreground">No epics.</p>
                  : data.epics.map((e) => {
                    const pct = e.total_tasks > 0 ? Math.round((e.done_tasks / e.total_tasks) * 100) : 0;
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
                          {e.total_tasks > 0 && (
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                                <span>{e.done_tasks}/{e.total_tasks} tasks</span>
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
                          {new Date(c.completed_at).toLocaleDateString()}
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
                {data.budgets.length === 0
                  ? <p className="text-muted-foreground">No budgets.</p>
                  : data.budgets.map((b) => {
                    // Postgres numeric columns come back as strings over JSON (no pg type-parser
                    // override in this app), so these must be coerced before .toLocaleString() —
                    // string values have no such method and would throw.
                    const actual = Number(b.actual_amount);
                    const target = Number(b.target_amount);
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
