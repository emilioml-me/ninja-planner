import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiClient } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Task {
  id: string; title: string; status: string; priority: string;
  due_date: string | null; assignee_clerk_id: string | null;
}

interface Sprint {
  id: string; name: string; status: string; start_date: string | null; end_date: string | null;
}

const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700 border-red-200',
  high:   'bg-orange-100 text-orange-700 border-orange-200',
  medium: 'bg-blue-100 text-blue-700 border-blue-200',
  low:    'bg-gray-100 text-gray-600 border-gray-200',
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function isoDate(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

export default function Calendar() {
  const { apiRequest } = useApiClient();
  const today = new Date();

  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const prevMonth = () => { if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 11) { setMonth(0); setYear(y => y + 1); } else setMonth(m => m + 1); };

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['tasks'],
    queryFn: () => apiRequest('GET', '/api/tasks'),
  });

  const { data: sprints = [] } = useQuery<Sprint[]>({
    queryKey: ['sprints'],
    queryFn: () => apiRequest('GET', '/api/sprints'),
  });

  // Build a map: dateKey -> { tasks, sprintStarts, sprintEnds }
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const tasksByDate = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.due_date && t.status !== 'done') {
      if (!tasksByDate.has(t.due_date)) tasksByDate.set(t.due_date, []);
      tasksByDate.get(t.due_date)!.push(t);
    }
  }

  const sprintRanges: { start: string; end: string; name: string; status: string }[] = sprints
    .filter((s) => s.start_date && s.end_date)
    .map((s) => ({ start: s.start_date!, end: s.end_date!, name: s.name, status: s.status }));

  function sprintsForDate(dateStr: string) {
    return sprintRanges.filter((s) => s.start <= dateStr && s.end >= dateStr);
  }

  // Build calendar grid
  const cells: (number | null)[] = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const todayStr = isoDate(today.getFullYear(), today.getMonth(), today.getDate());

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Calendar</h1>
          <p className="text-muted-foreground text-sm mt-1">Tasks by due date and sprint timelines</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={prevMonth}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="font-semibold w-36 text-center">{MONTHS[month]} {year}</span>
          <Button variant="outline" size="icon" onClick={nextMonth}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {/* Header */}
          <div className="grid grid-cols-7 border-b">
            {DAYS.map((d) => (
              <div key={d} className="py-2 text-center text-xs font-medium text-muted-foreground">{d}</div>
            ))}
          </div>

          {/* Grid */}
          <div className="grid grid-cols-7">
            {cells.map((day, idx) => {
              const dateStr = day ? isoDate(year, month, day) : '';
              const dayTasks = day ? (tasksByDate.get(dateStr) ?? []) : [];
              const daySprints = day ? sprintsForDate(dateStr) : [];
              const isToday = dateStr === todayStr;
              const isWeekend = idx % 7 === 0 || idx % 7 === 6;

              return (
                <div
                  key={idx}
                  className={cn(
                    'min-h-[110px] p-1.5 border-b border-r text-xs',
                    !day && 'bg-muted/30',
                    isWeekend && day && 'bg-muted/10',
                    idx % 7 === 6 && 'border-r-0',
                    Math.floor(idx / 7) === Math.floor((cells.length - 1) / 7) && 'border-b-0',
                  )}
                >
                  {day && (
                    <>
                      <div className={cn(
                        'w-6 h-6 flex items-center justify-center rounded-full text-xs font-medium mb-1',
                        isToday ? 'bg-primary text-primary-foreground' : 'text-foreground',
                      )}>
                        {day}
                      </div>

                      {/* Sprint indicators */}
                      {daySprints.map((s) => (
                        <div key={s.name}
                          className={cn(
                            'text-[10px] px-1 py-0.5 rounded mb-0.5 truncate',
                            s.status === 'active'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground',
                          )}>
                          {s.name}
                        </div>
                      ))}

                      {/* Task due dates */}
                      {dayTasks.slice(0, 3).map((t) => (
                        <div key={t.id}
                          className={cn(
                            'text-[10px] px-1 py-0.5 rounded mb-0.5 truncate border',
                            PRIORITY_COLOR[t.priority] ?? 'bg-muted',
                          )}>
                          {t.title}
                        </div>
                      ))}
                      {dayTasks.length > 3 && (
                        <div className="text-[10px] text-muted-foreground">
                          +{dayTasks.length - 3} more
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-primary/10 border border-primary/20 inline-block" />Active sprint</div>
        <div className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-200 inline-block" />Urgent task</div>
        <div className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-200 inline-block" />High priority</div>
        <div className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-100 border border-blue-200 inline-block" />Medium priority</div>
      </div>
    </div>
  );
}
