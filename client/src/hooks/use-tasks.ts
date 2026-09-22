import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import type { Task } from '@/components/TaskFormDialog';

/**
 * Max rows requested from GET /api/tasks (the server caps `limit` at 1000; its default is 500).
 * When more tasks match than this, pages must say so instead of silently presenting partial data
 * as the whole workspace.
 */
export const TASK_LIST_LIMIT = 1000;

/** Stable empty array so `tasks` keeps its identity across renders while loading. */
const EMPTY_TASKS: Task[] = [];

/**
 * Server-reported total (X-Total-Count) per fetched list. Kept beside the array rather than
 * wrapping it so the ['/api/tasks'] cache entry stays a plain Task[] (CommandPalette reads it).
 */
const totals = new WeakMap<Task[], number>();

function listState(data: Task[] | undefined) {
  const tasks = data ?? EMPTY_TASKS;
  const total = totals.get(tasks) ?? tasks.length;
  return { tasks, total, truncated: total > tasks.length || tasks.length >= TASK_LIST_LIMIT };
}

function useFetchTaskList() {
  const { apiRequestWithHeaders } = useApiClient();
  return async (url: string): Promise<Task[]> => {
    const { data, headers } = await apiRequestWithHeaders<Task[]>('GET', url);
    const header = Number(headers.get('X-Total-Count'));
    if (Number.isFinite(header) && header > 0) totals.set(data, header);
    return data;
  };
}

/**
 * Workspace task list. Keyed ['/api/tasks'] so every task mutation's
 * invalidateQueries({ queryKey: ['/api/tasks'] }) refreshes it, and so CommandPalette can read
 * the cached list with getQueryData(['/api/tasks']).
 */
export function useTaskList(options: { enabled?: boolean } = {}) {
  const fetchList = useFetchTaskList();
  const query = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    queryFn: () => fetchList(`/api/tasks?limit=${TASK_LIST_LIMIT}`),
    enabled: options.enabled ?? true,
    // Keep the fetched array reference so its X-Total-Count entry in `totals` stays attached.
    structuralSharing: false,
  });
  return { ...query, ...listState(query.data) };
}

/** Tasks assigned to one member, filtered server-side (?assignee=) so the cap applies per user. */
export function useAssignedTasks(assigneeClerkId: string | null | undefined) {
  const fetchList = useFetchTaskList();
  const query = useQuery<Task[]>({
    queryKey: ['/api/tasks', 'assignee', assigneeClerkId],
    queryFn: () =>
      fetchList(`/api/tasks?assignee=${encodeURIComponent(assigneeClerkId ?? '')}&limit=${TASK_LIST_LIMIT}`),
    enabled: !!assigneeClerkId,
    structuralSharing: false,
  });
  return { ...query, ...listState(query.data) };
}
