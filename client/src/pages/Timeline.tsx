import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TimelineTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  start_date: string | null;
  due_date: string | null;
  assignee_name: string | null;
  sprint_id: string | null;
  sprint_name: string | null;
  epic_id: string | null;
  epic_title: string | null;
  epic_color: string | null;
  story_points: number | null;
}

interface TimelineSprint {
  id: string;
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

interface TimelineData {
  tasks: TimelineTask[];
  sprints: TimelineSprint[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PX_PER_DAY   = 32;
const ROW_H        = 34;
const LABEL_W      = 220;
const HEADER_H     = 52;

const STATUS_BAR: Record<string, string> = {
  todo:        'bg-slate-400',
  in_progress: 'bg-blue-500',
  done:        'bg-green-500',
  blocked:     'bg-red-500',
};

const PRIORITY_DOTS: Record<string, string> = {
  urgent: 'bg-red-500',
  high:   'bg-orange-400',
  medium: 'bg-yellow-400',
  low:    'bg-slate-400',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function formatHeader(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildDateRange(tasks: TimelineTask[], sprints: TimelineSprint[]): { start: Date; end: Date; days: number } {
  const dates: Date[] = [];
  for (const t of tasks) {
    if (t.start_date) dates.push(parseDate(t.start_date));
    if (t.due_date)   dates.push(parseDate(t.due_date));
  }
  for (const s of sprints) {
    if (s.start_date) dates.push(parseDate(s.start_date));
    if (s.end_date)   dates.push(parseDate(s.end_date));
  }
  if (dates.length === 0) {
    const today = new Date();
    return { start: today, end: today, days: 30 };
  }
  const minD = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxD = new Date(Math.max(...dates.map((d) => d.getTime())));
  // Pad 7 days on each side
  minD.setDate(minD.getDate() - 7);
  maxD.setDate(maxD.getDate() + 7);
  const days = daysBetween(minD, maxD) + 1;
  return { start: minD, end: maxD, days };
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Timeline() {
  const { apiRequest } = useApiClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery<TimelineData>({
    queryKey: ['/api/timeline'],
    queryFn: () => apiRequest('GET', '/api/timeline'),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  const tasks   = data?.tasks   ?? [];
  const sprints = data?.sprints ?? [];

  if (tasks.length === 0) {
    return (
      <div className="p-6 max-w-2xl mx-auto flex flex-col items-center justify-center py-24 text-center">
        <CalendarDays className="h-10 w-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No tasks with dates yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Set a start date or due date on tasks to see them here.
        </p>
      </div>
    );
  }

  const { start, days } = buildDateRange(tasks, sprints);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayOffset = daysBetween(start, today);

  // Build week header markers
  const weekMarkers: { label: string; offset: number }[] = [];
  const cur = new Date(start);
  for (let d = 0; d < days; d++) {
    if (cur.getDay() === 1 || d === 0) { // Monday or first day
      weekMarkers.push({ label: formatHeader(cur), offset: d });
    }
    cur.setDate(cur.getDate() + 1);
  }

  // Group tasks by epic (ungrouped last)
  const epicMap = new Map<string, { title: string; color: string; tasks: TimelineTask[] }>();
  const ungrouped: TimelineTask[] = [];

  for (const task of tasks) {
    if (task.epic_id && task.epic_title) {
      if (!epicMap.has(task.epic_id)) {
        epicMap.set(task.epic_id, { title: task.epic_title, color: task.epic_color ?? '#6366f1', tasks: [] });
      }
      epicMap.get(task.epic_id)!.tasks.push(task);
    } else {
      ungrouped.push(task);
    }
  }

  // Flatten into rows: [group header?, ...task rows]
  interface Row {
    type: 'epic-header' | 'task';
    epic?: { title: string; color: string };
    task?: TimelineTask;
  }
  const rows: Row[] = [];
  for (const [, epic] of epicMap) {
    rows.push({ type: 'epic-header', epic });
    for (const t of epic.tasks) rows.push({ type: 'task', task: t });
  }
  if (ungrouped.length > 0) {
    if (epicMap.size > 0) rows.push({ type: 'epic-header', epic: { title: 'No Epic', color: '#94a3b8' } });
    for (const t of ungrouped) rows.push({ type: 'task', task: t });
  }

  const chartW = days * PX_PER_DAY;
  const chartH = rows.length * ROW_H;

  function taskBar(task: TimelineTask, rowIdx: number) {
    const s = task.start_date ? daysBetween(start, parseDate(task.start_date)) : null;
    const e = task.due_date   ? daysBetween(start, parseDate(task.due_date))   : null;

    if (s === null && e === null) return null;

    // If only due_date: milestone diamond
    if (s === null && e !== null) {
      const x = e * PX_PER_DAY;
      const y = rowIdx * ROW_H + ROW_H / 2 - 7;
      const color = STATUS_BAR[task.status] ?? 'bg-slate-400';
      return (
        <div
          key={task.id + '-m'}
          title={`${task.title} (due ${task.due_date})`}
          className={cn('absolute flex items-center justify-center rounded-sm text-white text-[9px] font-medium', color)}
          style={{ left: x - 7, top: y, width: 14, height: 14, transform: 'rotate(45deg)' }}
        />
      );
    }

    const left   = (s ?? e ?? 0) * PX_PER_DAY;
    const right  = (e ?? s ?? 0) * PX_PER_DAY + PX_PER_DAY;
    const width  = Math.max(right - left, PX_PER_DAY);
    const top    = rowIdx * ROW_H + 6;
    const height = ROW_H - 14;
    const color  = STATUS_BAR[task.status] ?? 'bg-slate-400';

    return (
      <div
        key={task.id}
        title={`${task.title}${task.assignee_name ? ` · ${task.assignee_name}` : ''}${task.story_points ? ` · ${task.story_points}pts` : ''}`}
        className={cn('absolute rounded flex items-center px-1.5 overflow-hidden text-white cursor-default select-none group', color)}
        style={{ left, top, width, height }}
      >
        <span className="text-[10px] font-medium truncate leading-none">{task.title}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Page header */}
      <div className="px-6 py-4 border-b flex items-center gap-3 shrink-0">
        <CalendarDays className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-xl font-bold">Timeline</h1>
          <p className="text-xs text-muted-foreground">{tasks.length} tasks with dates</p>
        </div>
      </div>

      {/* Gantt body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Fixed label column */}
        <div className="shrink-0 border-r bg-card flex flex-col" style={{ width: LABEL_W }}>
          {/* Header spacer */}
          <div style={{ height: HEADER_H }} className="border-b" />
          {/* Row labels */}
          <div className="overflow-hidden flex-1">
            {rows.map((row, i) => {
              if (row.type === 'epic-header') {
                return (
                  <div key={`eh-${i}`}
                    className="flex items-center gap-2 px-3 text-xs font-semibold text-muted-foreground bg-muted/30 border-b"
                    style={{ height: ROW_H }}
                  >
                    {row.epic && (
                      <>
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: row.epic.color }} />
                        <span className="truncate">{row.epic.title}</span>
                      </>
                    )}
                  </div>
                );
              }
              const task = row.task!;
              return (
                <div key={task.id}
                  className="flex items-center gap-2 px-3 border-b hover:bg-muted/20 transition-colors"
                  style={{ height: ROW_H }}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', PRIORITY_DOTS[task.priority] ?? 'bg-slate-400')} />
                  <span className="text-xs truncate flex-1 text-muted-foreground">{task.title}</span>
                  {task.story_points != null && (
                    <span className="text-[9px] text-muted-foreground shrink-0">{task.story_points}p</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Scrollable chart area */}
        <div ref={scrollRef} className="flex-1 overflow-auto">
          <div style={{ width: chartW, position: 'relative' }}>
            {/* Date header */}
            <div
              className="sticky top-0 z-20 bg-card border-b flex"
              style={{ height: HEADER_H }}
            >
              {weekMarkers.map((wm, i) => (
                <div
                  key={i}
                  className="absolute top-0 flex flex-col justify-end pb-1 pl-1"
                  style={{ left: wm.offset * PX_PER_DAY }}
                >
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">{wm.label}</span>
                </div>
              ))}
            </div>

            {/* Grid + bars */}
            <div style={{ position: 'relative', height: chartH }}>
              {/* Vertical day/week lines */}
              {weekMarkers.map((wm, i) => (
                <div
                  key={i}
                  className="absolute top-0 bottom-0 border-l border-border/40"
                  style={{ left: wm.offset * PX_PER_DAY }}
                />
              ))}

              {/* Sprint bands */}
              {sprints.map((sp) => {
                if (!sp.start_date || !sp.end_date) return null;
                const sx = daysBetween(start, parseDate(sp.start_date)) * PX_PER_DAY;
                const ex = (daysBetween(start, parseDate(sp.end_date)) + 1) * PX_PER_DAY;
                return (
                  <div
                    key={sp.id}
                    className="absolute top-0 bottom-0 bg-primary/5 border-x border-primary/20"
                    style={{ left: sx, width: ex - sx }}
                    title={sp.name}
                  >
                    <span className="text-[9px] text-primary/60 font-medium pl-1 pt-0.5 block truncate">
                      {sp.name}
                    </span>
                  </div>
                );
              })}

              {/* Today marker */}
              {todayOffset >= 0 && todayOffset < days && (
                <div
                  className="absolute top-0 bottom-0 border-l-2 border-red-500/70 z-10"
                  style={{ left: todayOffset * PX_PER_DAY }}
                >
                  <div className="text-[9px] text-red-500 font-bold pl-0.5">today</div>
                </div>
              )}

              {/* Horizontal row dividers */}
              {rows.map((_, i) => (
                <div
                  key={i}
                  className="absolute left-0 right-0 border-b border-border/20"
                  style={{ top: i * ROW_H + ROW_H - 1 }}
                />
              ))}

              {/* Task bars */}
              {rows.map((row, i) => {
                if (row.type !== 'task' || !row.task) return null;
                return taskBar(row.task, i);
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="px-6 py-2 border-t flex flex-wrap gap-4 text-[10px] text-muted-foreground shrink-0">
        {Object.entries(STATUS_BAR).map(([s, c]) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn('h-2.5 w-2.5 rounded-sm', c)} />
            {s.replace('_', ' ')}
          </span>
        ))}
        <span className="flex items-center gap-1 ml-4">
          <span className="h-2.5 w-2.5 rotate-45 bg-primary/50 inline-block rounded-sm" /> milestone (due only)
        </span>
        <span className="flex items-center gap-1 ml-4">
          <span className="border-l-2 border-red-500/70 h-3 inline-block" /> today
        </span>
      </div>
    </div>
  );
}
