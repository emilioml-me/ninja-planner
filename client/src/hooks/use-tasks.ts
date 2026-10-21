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
 * wrapping it so the ['/api/tasks'] cache entry stays a plain Task[].
 */
const totals = new WeakMap<Task[], number>();

function listState(data: Task[] | undefined) {
  const tasks = data ?? EMPTY_TASKS;
  const reported = totals.get(tasks);
  // With the server total we know exactly whether rows were cut off (a workspace with exactly
  // TASK_LIST_LIMIT tasks is complete). Without it, a full page is the only hint.
  const total = reported ?? tasks.length;
  const truncated = reported !== undefined ? reported > tasks.length : tasks.length >= TASK_LIST_LIMIT;
  return { tasks, total, truncated };
}

function useFetchTaskList() {
  const { apiRequestWithHeaders } = useApiClient();
  return async (url: string): Promise<Task[]> => {
    const { data, headers } = await apiRequestWithHeaders<Task[]>('GET', url);
    const raw = headers.get('X-Total-Count');
    const header = raw == null || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(header) && header >= 0) totals.set(data, header);
    return data;
  };
}

/**
 * Workspace task list. Keyed ['/api/tasks'] so every task mutation's
 * invalidateQueries({ queryKey: ['/api/tasks'] }) refreshes it. This is the ONLY reader of the
 * exact ['/api/tasks'] key: any other fetch on that key (different limit, no X-Total-Count
 * bookkeeping) would silently replace this list, so pickers must use this hook too.
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
