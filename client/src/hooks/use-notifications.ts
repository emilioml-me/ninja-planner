import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';

export interface Notification {
  id: string;
  workspace_id: string;
  recipient_clerk_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export function useNotifications() {
  const { apiRequest } = useApiClient();
  return useQuery<Notification[]>({
    queryKey: ['/api/notifications'],
    queryFn: () => apiRequest('GET', '/api/notifications'),
    staleTime: 30_000,
    refetchInterval: 60_000, // poll every minute
  });
}

export function useUnreadCount() {
  const { apiRequest } = useApiClient();
  return useQuery<{ count: number }>({
    queryKey: ['/api/notifications/unread-count'],
    queryFn: () => apiRequest('GET', '/api/notifications/unread-count'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useMarkRead() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest('PATCH', `/api/notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/notifications'] });
      qc.invalidateQueries({ queryKey: ['/api/notifications/unread-count'] });
    },
  });
}

export function useMarkAllRead() {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('PATCH', '/api/notifications/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/notifications'] });
      qc.invalidateQueries({ queryKey: ['/api/notifications/unread-count'] });
    },
  });
}

export function useTaskComments(taskId: string | undefined) {
  const { apiRequest } = useApiClient();
  return useQuery<import('./use-notifications').TaskComment[]>({
    queryKey: ['/api/tasks', taskId, 'comments'],
    queryFn: () => apiRequest('GET', `/api/tasks/${taskId}/comments`),
    enabled: !!taskId,
    staleTime: 30_000,
  });
}

export interface TaskComment {
  id: string;
  task_id: string;
  author_clerk_id: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export function useAddComment(taskId: string) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      apiRequest('POST', `/api/tasks/${taskId}/comments`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', taskId, 'comments'] });
    },
  });
}

export function useDeleteComment(taskId: string) {
  const { apiRequest } = useApiClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      apiRequest('DELETE', `/api/tasks/${taskId}/comments/${commentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/tasks', taskId, 'comments'] });
    },
  });
}
