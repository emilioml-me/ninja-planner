import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';

export interface WorkspaceMember {
  id: string;
  clerk_user_id: string;
  role: string;
  display_name: string;
  image_url: string | null;
}

export function useMembers() {
  const { apiRequest } = useApiClient();

  const { data: members = [], isLoading } = useQuery<WorkspaceMember[]>({
    queryKey: ['/api/workspaces/me/members'],
    queryFn: () => apiRequest<WorkspaceMember[]>('GET', '/api/workspaces/me/members'),
    staleTime: 5 * 60 * 1000,
  });

  // Memoized so `lookup`/`displayName`/`initials` keep stable references across renders where
  // `members` hasn't changed — otherwise every consumer using these as a useEffect/useMemo/
  // useCallback dependency (or passing them to a React.memo child) re-fires/re-renders on every
  // parent render, not just when the member list actually changes.
  const lookup = useMemo(() => new Map(members.map((m) => [m.clerk_user_id, m])), [members]);

  const displayName = useCallback((clerkUserId: string | null | undefined): string => {
    if (!clerkUserId) return '';
    return lookup.get(clerkUserId)?.display_name ?? clerkUserId;
  }, [lookup]);

  const initials = useCallback((clerkUserId: string | null | undefined): string => {
    const name = displayName(clerkUserId);
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }, [displayName]);

  return { members, lookup, displayName, initials, isLoading };
}
