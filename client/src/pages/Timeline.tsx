import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryError } from '@/components/QueryError';
import { CalendarDays, AlertTriangle } from 'lucide-react';
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
  truncated?: boolean;
  /** Server's "today" (YYYY-MM-DD) in the requester's timezone. */
  today?: string;
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

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Parses a YYYY-MM-DD (or ISO timestamp) date; null when missing or unparseable. */
function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = parseDate(s.slice(0, 10));
  return Number.isNaN(d.getTime()) ? null : d;
}

// The chart never extends past today -1 year .. +2 years: one far-off date (e.g. 9999-12-31)
// would otherwise produce a multi-million-day range and hundreds of thousands of DOM nodes.
const WINDOW_PAST_DAYS   = 365;
const WINDOW_FUTURE_DAYS = 730;

interface Span { from: Date; to: Date }

/** A task's [earliest, latest] date (start and due may be in either order, or only one set). */
function taskSpan(t: TimelineTask): Span | null {
  const s = toDate(t.start_date);
  const e = toDate(t.due_date);
  if (!s && !e) return null;
  const a = s ?? e!;
  const b = e ?? s!;
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

function buildDateRange(spans: Span[], today: Date, lo: Date, hi: Date): { start: Date; days: number } {
  // Always include today so the chart can open on it.
  let min = today.getTime();
  let max = today.getTime();
  for (const sp of spans) {
    min = Math.min(min, Math.max(sp.from.getTime(), lo.getTime()));
    max = Math.max(max, Math.min(sp.to.getTime(), hi.getTime()));
  }
  // Pad 7 days on each side
  const start = addDays(new Date(min), -7);
  const end   = addDays(new Date(max), 7);
  return { start, days: daysBetween(start, end) + 1 };
}

function overlaps(sp: Span, lo: Date, hi: Date): boolean {
  return sp.to >= lo && sp.from <= hi;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Timeline() {
  const { apiRequest } = useApiClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);

  // The label column and the chart are separate boxes; keep their vertical scroll in sync so
  // task labels stay aligned with their bars (previously the labels never scrolled at all).
  const syncLabels = useCallback(() => {
    if (labelsRef.current && scrollRef.current) {
      labelsRef.current.scrollTop = scrollRef.current.scrollTop;
    }
  }, []);
  const forwardWheel = useCallback((e: React.WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    // deltaMode: 0 = pixels, 1 = lines, 2 = pages (Firefox reports lines for mouse wheels).
    const scale = e.deltaMode === 1 ? ROW_H : e.deltaMode === 2 ? el.clientHeight : 1;
    el.scrollTop += e.deltaY * scale;
  }, []);

  const { data, isLoading, isError, error, refetch } = useQuery<TimelineData>({
    queryKey: ['/api/timeline'],
    queryFn: () => apiRequest('GET', '/api/timeline'),
    staleTime: 30_000,
  });

  const layout = useMemo(() => {
    const tasks   = data?.tasks   ?? [];
    const sprints = data?.sprints ?? [];
    const today = toDate(data?.today ?? null) ?? new Date();
    today.setHours(0, 0, 0, 0);
    const lo = addDays(today, -WINDOW_PAST_DAYS);
    const hi = addDays(today, WINDOW_FUTURE_DAYS);

    const visibleTasks: TimelineTask[] = [];
    const spans: Span[] = [];
    let hiddenCount = 0;
    for (const t of tasks) {
      const sp = taskSpan(t);
      if (!sp) continue;
      if (!overlaps(sp, lo, hi)) { hiddenCount++; continue; }
      visibleTasks.push(t);
      spans.push(sp);
    }
    const sprintSpans: { sprint: TimelineSprint; span: Span }[] = [];
    for (const s of sprints) {
      const a = toDate(s.start_date);
      const b = toDate(s.end_date);
      if (!a || !b) continue;
      const span = a <= b ? { from: a, to: b } : { from: b, to: a };
      if (overlaps(span, lo, hi)) sprintSpans.push({ sprint: s, span });
    }

    const { start, days } = buildDateRange([...spans, ...sprintSpans.map((s) => s.span)], today, lo, hi);
    const todayOffset = daysBetween(start, today);

    // Build week header markers (days is bounded by the window above, so this stays small)
    const weekMarkers: { label: string; offset: number }[] = [];
    const cur = new Date(start);
    for (let d = 0; d < days; d++) {
      if (cur.getDay() === 1 || d === 0) { // Monday or first day
        weekMarkers.push({ label: formatHeader(cur), offset: d });
      }
      cur.setDate(cur.getDate() + 1);
    }

    return { visibleTasks, sprintSpans, hiddenCount, start, days, todayOffset, weekMarkers };
  }, [data]);

  // Open the chart scrolled to today (once per mount), with a little context to its left.
  const scrolledToToday = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrolledToToday.current || layout.visibleTasks.length === 0) return;
    scrolledToToday.current = true;
    el.scrollLeft = Math.max(0, layout.todayOffset * PX_PER_DAY - el.clientWidth / 3);
  }, [layout]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <QueryError error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const truncated = data?.truncated ?? false;
  const { visibleTasks: tasks, sprintSpans, hiddenCount, start, days, todayOffset, weekMarkers } = layout;

  if (tasks.length === 0) {
    return (
      <div className="p-6 max-w-2xl mx-auto flex flex-col items-center justify-center py-24 text-center">
        <CalendarDays className="h-10 w-10 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">
          {hiddenCount > 0 ? 'No tasks in the visible range' : 'No tasks with dates yet'}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {hiddenCount > 0
            ? `${hiddenCount} dated task${hiddenCount === 1 ? '' : 's'} fall more than 1 year in the past or 2 years in the future.`
            : 'Set a start date or due date on tasks to see them here.'}
        </p>
      </div>
    );
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

  // Keep day offsets inside the drawn range (tasks partly outside the window are clipped).
  const clampDay = (d: number) => Math.min(Math.max(d, 0), days - 1);

  function taskBar(task: TimelineTask, rowIdx: number) {
    const sd = toDate(task.start_date);
    const ed = toDate(task.due_date);
    const s = sd ? daysBetween(start, sd) : null;
    const e = ed ? daysBetween(start, ed) : null;

    if (s === null && e === null) return null;

    // If only due_date: milestone diamond
    if (s === null && e !== null) {
      if (e < 0 || e >= days) return null;
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

    const a = s ?? e!;
    const b = e ?? s!;
    // A start date after the due date is drawn across both dates and outlined as a warning,
    // rather than collapsing to a 1-day bar.
    const inverted = s !== null && e !== null && s > e;
    const from   = clampDay(Math.min(a, b));
    const to     = clampDay(Math.max(a, b));
    const left   = from * PX_PER_DAY;
    const width  = (to - from + 1) * PX_PER_DAY;
    const top    = rowIdx * ROW_H + 6;
    const height = ROW_H - 14;
    const color  = STATUS_BAR[task.status] ?? 'bg-slate-400';

    return (
      <div
        key={task.id}
        title={`${task.title}${task.assignee_name ? ` · ${task.assignee_name}` : ''}${task.story_points ? ` · ${task.story_points}pts` : ''}${inverted ? ' · start date is after due date' : ''}`}
        className={cn(
          'absolute rounded flex items-center px-1.5 overflow-hidden text-white cursor-default select-none group',
          color,
          inverted && 'ring-2 ring-red-600 ring-offset-1',
        )}
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

      {hiddenCount > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b bg-muted/40 text-muted-foreground text-xs shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {hiddenCount} task{hiddenCount === 1 ? '' : 's'} dated more than 1 year ago or 2 years ahead {hiddenCount === 1 ? 'is' : 'are'} not shown.
        </div>
      )}

      {truncated && (
        <div className="flex items-center gap-2 px-6 py-2 border-b bg-yellow-50 text-yellow-800 dark:bg-yellow-950/40 dark:text-yellow-300 text-xs shrink-0">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          Too many dated tasks to show at once; only part of the timeline is displayed.
        </div>
      )}

      {/* Gantt body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Fixed label column */}
        <div className="shrink-0 border-r bg-card flex flex-col" style={{ width: LABEL_W }}>
          {/* Header spacer */}
          <div style={{ height: HEADER_H }} className="border-b" />
          {/* Row labels */}
          <div ref={labelsRef} className="overflow-hidden flex-1" onWheel={forwardWheel}>
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
            {/* Room for the chart's horizontal scrollbar so the last rows can align too */}
            <div style={{ height: 24 }} />
          </div>
        </div>

        {/* Scrollable chart area */}
        <div ref={scrollRef} className="flex-1 overflow-auto" onScroll={syncLabels}>
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
              {sprintSpans.map(({ sprint: sp, span }) => {
                const sx = clampDay(daysBetween(start, span.from)) * PX_PER_DAY;
                const ex = (clampDay(daysBetween(start, span.to)) + 1) * PX_PER_DAY;
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
          <span className="h-2.5 w-2.5 rotate-45 border border-muted-foreground bg-transparent inline-block rounded-sm" /> milestone (due only, colored by status)
        </span>
        <span className="flex items-center gap-1 ml-4">
          <span className="border-l-2 border-red-500/70 h-3 inline-block" /> today
        </span>
      </div>
    </div>
  );
}
