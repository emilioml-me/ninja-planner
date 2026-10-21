import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useClerk, OrganizationList, OrganizationSwitcher } from '@clerk/clerk-react';
import { Loader2, AlertTriangle, RefreshCw, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, useApiClient } from '@/lib/api';

interface Workspace {
  id: string;
  name: string;
  clerk_org_id: string;
}

/** GET /api/workspaces/current answers 404 until the workspace row + membership exist. */
function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** How long to keep polling a "being set up" workspace before giving up. */
const PROVISIONING_TIMEOUT_MS = 60_000;
const PROVISIONING_POLL_MS = 5_000;

/**
 * WorkspaceGate — wraps the authenticated app shell.
 *
 * - No active org: lets the user pick one of their workspaces (or create one) instead of always
 *   pushing them to create a new, empty workspace.
 * - Workspace row not there yet (Clerk webhook in flight): polls for ~60s, then stops and offers
 *   to switch workspace or sign out (e.g. a removed member would otherwise poll forever).
 * - Once the workspace has loaded, a failed background refetch never unmounts the app (open
 *   dialogs / unsaved forms survive); the error screen is only for when there's no data.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const { orgId } = useAuth();
  const { signOut } = useClerk();
  const { apiRequest } = useApiClient();

  // When the current org's 404 polling started; reset when the org changes.
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [pollExpired, setPollExpired] = useState(false);
  useEffect(() => {
    setPollStartedAt(null);
    setPollExpired(false);
  }, [orgId]);

  // Resolves the workspace for the ACTIVE org. Keyed by orgId so switching orgs re-checks
  // instead of reusing the previous org's cached answer.
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<Workspace>({
    queryKey: ['/api/workspaces/current', orgId],
    queryFn: () => apiRequest<Workspace>('GET', '/api/workspaces/current'),
    enabled: !!orgId,
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status >= 400 && err.status < 500) && failureCount < 1,
    // While the workspace is still being provisioned (webhook in flight), poll so the gate opens
    // on its own once it lands - but not forever.
    refetchInterval: (query) =>
      isNotFoundError(query.state.error) && !query.state.data && !pollExpired ? PROVISIONING_POLL_MS : false,
    staleTime: 5 * 60 * 1000,
  });

  const notFound = !data && isNotFoundError(error);
  useEffect(() => {
    if (!notFound) {
      if (pollStartedAt !== null) setPollStartedAt(null);
      return;
    }
    if (pollStartedAt === null) {
      setPollStartedAt(Date.now());
      return;
    }
    const remaining = PROVISIONING_TIMEOUT_MS - (Date.now() - pollStartedAt);
    if (remaining <= 0) {
      setPollExpired(true);
      return;
    }
    const timer = setTimeout(() => setPollExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [notFound, pollStartedAt]);

  const retry = () => {
    setPollExpired(false);
    setPollStartedAt(Date.now());
    void refetch();
  };

  // No org selected — pick an existing workspace or create one.
  if (!orgId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="flex flex-col items-center gap-6">
          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold">Welcome to Ninja Planner</h1>
            <p className="text-sm text-muted-foreground">
              Choose a workspace, or create one to get started.
            </p>
          </div>
          <OrganizationList
            hidePersonal
            afterSelectOrganizationUrl="/dashboard"
            afterCreateOrganizationUrl="/dashboard"
            skipInvitationScreen
          />
        </div>
      </div>
    );
  }

  if (data) return <>{children}</>;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const status = error instanceof ApiError ? error.status : undefined;
  // 403 = the session has no usable org (or the user isn't allowed in it): retrying the same
  // request can't help, so only offer switching workspace / signing out.
  const canRetry = status !== 403 && !(notFound && !pollExpired);
  const provisioning = notFound && !pollExpired;

  let message: string;
  if (provisioning) {
    message = 'Your workspace is being set up. This usually takes a few seconds after your first sign-in.';
  } else if (notFound) {
    message =
      "We couldn't find this workspace for your account. You may have been removed from it, or it's still being set up. Switch to another workspace, try again, or sign out.";
  } else if (status === 403) {
    message = 'You don\'t have access to a workspace in this session. Pick a workspace below, or sign out and back in.';
  } else {
    message = (isError && (error as { message?: string })?.message) || 'Could not load workspace.';
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-sm px-4">
        {provisioning ? (
          <Loader2 className="h-10 w-10 animate-spin text-muted-foreground mx-auto" />
        ) : (
          <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
        )}
        <h2 className="text-lg font-semibold">{provisioning ? 'Setting up your workspace' : 'Workspace not ready'}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {canRetry && (
            <Button onClick={retry} disabled={isFetching} className="gap-2">
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Try again
            </Button>
          )}
          <Button variant="outline" className="gap-2" onClick={() => void signOut({ redirectUrl: '/' })}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
        {!provisioning && (
          <div className="flex justify-center pt-2">
            <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/dashboard" afterCreateOrganizationUrl="/dashboard" />
          </div>
        )}
      </div>
    </div>
  );
}
