import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Bell } from 'lucide-react';

const TYPE_LABELS: Record<string, { label: string; hint: string }> = {
  comment_added:    { label: 'Comments',            hint: 'New comments on tasks and epics you\'re involved in' },
  mention:          { label: 'Mentions',            hint: 'When someone @mentions you in a comment' },
  task_assigned:    { label: 'Task assigned',       hint: 'When a task is assigned to you' },
  due_date_set:     { label: 'Due date reminders',  hint: 'When a due date is set or changed on your task' },
  task_updated:     { label: 'Watched task updates', hint: 'Changes to tasks you\'re watching' },
  overdue_alert:    { label: 'Overdue tasks',       hint: 'Daily summary of overdue tasks in the workspace' },
  sprint_ending:    { label: 'Sprint ending soon',  hint: 'Reminders when an active sprint is about to end' },
  goal_milestone:   { label: 'Goal milestones',     hint: 'When a goal crosses 50% or reaches completion' },
  review_submitted: { label: 'Weekly review submitted', hint: 'When a teammate submits their weekly review' },
  automation:       { label: 'Automation alerts',   hint: 'Notifications triggered by automation rules' },
};

export default function NotificationPreferences() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();

  const { data: prefs, isLoading } = useQuery<Record<string, boolean>>({
    queryKey: ['notification-preferences'],
    queryFn: () => apiRequest('GET', '/api/notifications/preferences'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ type, enabled }: { type: string; enabled: boolean }) =>
      apiRequest('PUT', `/api/notifications/preferences/${type}`, { enabled }),
    onMutate: async ({ type, enabled }) => {
      await qc.cancelQueries({ queryKey: ['notification-preferences'] });
      const prev = qc.getQueryData<Record<string, boolean>>(['notification-preferences']);
      qc.setQueryData(['notification-preferences'], (old?: Record<string, boolean>) => ({ ...old, [type]: enabled }));
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['notification-preferences'], ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['notification-preferences'] }),
  });

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Bell className="h-5 w-5" /> Notification Preferences</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Choose which in-app notifications you want to receive. This only affects you — other
          workspace members keep their own settings.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1,2,3,4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <Card>
          <CardContent className="p-0 divide-y">
            {Object.entries(TYPE_LABELS).map(([type, { label, hint }]) => (
              <div key={type} className="flex items-center justify-between px-4 py-3">
                <div className="min-w-0 pr-4">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0"
                  checked={prefs?.[type] ?? true}
                  onChange={(e) => toggleMutation.mutate({ type, enabled: e.target.checked })}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
