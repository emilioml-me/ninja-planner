import { useAuth } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';

/** Response of GET /api/workspaces/me: the active workspace plus the caller's stored role. */
export interface MyWorkspace {
  id: string;
  name: string;
  clerk_org_id: string;
  my_role: string | null;
  [key: string]: unknown;
}

export interface MyRole {
  /** workspace_members.role for the current user ('org:owner' | 'org:admin' | 'org:member' | 'viewer'). */
  role: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  isViewer: boolean;
  /** True until the role is known. Hide privileged controls (and show skeletons) while loading. */
  isLoading: boolean;
}

const ADMIN_ROLES = new Set(['org:admin', 'org:owner']);

/**
 * The current user's role in the active workspace, as stored in workspace_members (the same
 * source the server's requireAdmin / viewer write block use), not Clerk's session orgRole, which
 * can lag behind role changes until the webhook lands and the token refreshes.
 *
 * Keyed by ['/api/workspaces/me', orgId] so switching orgs re-fetches; invalidating the prefix
 * ['/api/workspaces/me'] (e.g. after a role change) refreshes it.
 */
export function useMyRole(): MyRole {
  const { orgId, isLoaded } = useAuth();
  const { apiRequest } = useApiClient();
  const { data, isLoading, isError } = useQuery<MyWorkspace | MyWorkspace[]>({
    queryKey: ['/api/workspaces/me', orgId],
    queryFn: () => apiRequest('GET', '/api/workspaces/me'),
    enabled: isLoaded && !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  // Tolerates the legacy array shape (no my_role) by treating the role as unknown.
  const role = data && !Array.isArray(data) && typeof data.my_role === 'string' ? data.my_role : null;
  return {
    role,
    isAdmin: !!role && ADMIN_ROLES.has(role),
    isOwner: role === 'org:owner',
    isViewer: role === 'viewer',
    isLoading: !isLoaded || (!!orgId && isLoading && !isError),
  };
}

/** True if the current user is an admin or owner of the active workspace (false while loading). */
export function useIsAdmin(): boolean {
  return useMyRole().isAdmin;
}

/** True if the current user is a read-only viewer (false while loading - check useMyRole().isLoading). */
export function useIsViewer(): boolean {
  return useMyRole().isViewer;
}

/** True once the role has resolved (and useIsAdmin()/useIsViewer() results can be trusted). */
export function useIsAdminLoaded(): boolean {
  return !useMyRole().isLoading;
}
