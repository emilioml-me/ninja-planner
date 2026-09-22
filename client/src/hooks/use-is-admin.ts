import { useAuth } from '@clerk/clerk-react';

/**
 * Returns true if the current user has admin or owner role in the active org.
 * Used to gate destructive UI actions that are 403'd on the backend for non-admins.
 *
 * Before Clerk finishes loading, `orgRole` is `undefined`, so this returns `false` even for an
 * actual admin — fine for small, incidental UI gates (hiding one button), but a page that
 * blocks its ENTIRE content behind this (e.g. "Admin access required") should also check
 * useIsAdminLoaded() to avoid flashing that block on every cold load/refresh before Clerk
 * resolves.
 */
export function useIsAdmin(): boolean {
  const { orgRole } = useAuth();
  return orgRole === 'org:admin' || orgRole === 'org:owner';
}

/** True once Clerk has resolved auth state (and useIsAdmin()'s result can be trusted). */
export function useIsAdminLoaded(): boolean {
  const { isLoaded } = useAuth();
  return isLoaded;
}
