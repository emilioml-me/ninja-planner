import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useApiClient } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { History, Download, CheckCircle2, Layers, Zap } from 'lucide-react';
import { downloadCsv } from '@/lib/export-csv';
import { cn } from '@/lib/utils';

interface ChangelogTask {
  id: string;
  title: string;
  priority: string;
  story_points: number | null;
  assignee_name: string | null;
  completed_at: string;
  sprint_name: string | null;
  epic_title: string | null;
  epic_color: string | null;
}

interface ChangelogGroup {
  sprint_id: string | null;
  sprint_name: string | null;
  epic_id: string | null;
  epic_title: string | null;
  epic_color: string | null;
  tasks: ChangelogTask[];
  total_points: number;
}

interface ChangelogResponse {
  from: string;
  to: string;
  total_tasks: number;
  total_points: number;
  groups: ChangelogGroup[];
}

const PRIORITY_COLORS: Record<string, string> = {
  low:    'bg-slate-100 text-slate-600',
  medium: 'bg-yellow-100 text-yellow-700',
  high:   'bg-orange-100 text-orange-700',
  urgent: 'bg-red-100 text-red-700',
};

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

export default function Changelog() {
  const { apiRequest } = useApiClient();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo]     = useState(new Date().toISOString().slice(0, 10));

  const { data, isLoading } = useQuery<ChangelogResponse>({
    queryKey: ['/api/changelog', from, to],
    queryFn: () => apiRequest('GET', `/api/changelog?from=${from}&to=${to}`),
  });

  const exportCsv = () => {
    if (!data) return;
    const rows = data.groups.flatMap((g) =>
      g.tasks.map((t) => ({
        completed_at: t.completed_at.slice(0, 10),
        title:        t.title,
        priority:     t.priority,
        story_points: t.story_points ?? '',
        sprint:       g.sprint_name ?? '',
        epic:         t.epic_title ?? '',
        assignee:     t.assignee_name ?? '',
      })),
    );
    downloadCsv(`changelog-${from}-to-${to}.csv`, rows);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="h-6 w-6 text-primary" /> Changelog
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Completed tasks — what shipped and when.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-xs" />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">To</label>
            <Input type="date" value={to}   onChange={(e) => setTo(e.target.value)}   className="h-8 w-36 text-xs" />
          </div>
          {data && data.total_tasks > 0 && (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5" /> Export
            </Button>
          )}
        </div>
      </div>

      {/* Summary strip */}
      {data && (
        <div className="flex gap-6 text-sm">
          <span>
            <span className="font-semibold text-foreground">{data.total_tasks}</span>
            <span className="text-muted-foreground ml-1">tasks shipped</span>
          </span>
          {data.total_points > 0 && (
            <span>
              <span className="font-semibold text-foreground">{data.total_points}</span>
              <span className="text-muted-foreground ml-1">points delivered</span>
            </span>
          )}
          <span className="text-muted-foreground">
            {format(new Date(data.from + 'T00:00:00'), 'MMM d')} – {format(new Date(data.to + 'T00:00:00'), 'MMM d, yyyy')}
          </span>
        </div>
      )}

      {/* Groups */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <Card key={i}><CardContent className="pt-4"><Skeleton className="h-32 w-full" /></CardContent></Card>
          ))}
        </div>
      ) : !data || data.groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <History className="h-10 w-10 text-muted-foreground/30 mb-3" />
          <p className="text-sm font-medium text-muted-foreground">No completed tasks in this range</p>
          <p className="text-xs text-muted-foreground mt-1">Try extending the date range.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.groups.map((group, gi) => {
            const groupLabel = group.sprint_name
              ? <><Zap className="h-3.5 w-3.5 text-primary inline-block mr-1" />{group.sprint_name}</>
              : group.epic_title
                ? (
                  <>
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full mr-1.5 align-middle"
                      style={{ backgroundColor: group.epic_color ?? '#6366f1' }}
                    />
                    {group.epic_title}
                  </>
                )
                : <><Layers className="h-3.5 w-3.5 text-muted-foreground inline-block mr-1" />Ungroups</>;

            return (
              <Card key={gi}>
                <CardHeader className="pb-2 pt-4 px-4">
                  <CardTitle className="text-sm font-semibold flex items-center justify-between">
                    <span>{groupLabel}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {group.tasks.length} task{group.tasks.length !== 1 ? 's' : ''}
                      {group.total_points > 0 && ` · ${group.total_points} pts`}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 px-4 pb-3">
                  <div className="space-y-1.5">
                    {group.tasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{task.title}</span>
                        {task.story_points != null && (
                          <span className="text-[10px] text-muted-foreground shrink-0">{task.story_points}pt</span>
                        )}
                        <span className={cn('text-[10px] rounded px-1.5 py-0.5 shrink-0', PRIORITY_COLORS[task.priority] ?? '')}>
                          {task.priority}
                        </span>
                        {task.assignee_name && (
                          <span className="text-[10px] text-muted-foreground shrink-0 hidden sm:block">
                            {task.assignee_name.split(' ')[0]}
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {format(new Date(task.completed_at), 'MMM d')}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
