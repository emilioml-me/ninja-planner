import { useAuth } from '@clerk/clerk-react';

/**
 * Returns true if the current user has admin or owner role in the active org.
 * Used to gate destructive UI actions that are 403'd on the backend for non-admins.
 */
export function useIsAdmin(): boolean {
  const { orgRole } = useAuth();
  return orgRole === 'org:admin' || orgRole === 'org:owner';
}
