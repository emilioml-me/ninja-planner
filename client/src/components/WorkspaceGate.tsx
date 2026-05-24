import { useQuery } from '@tanstack/react-query';
import { useAuth, CreateOrganization } from '@clerk/clerk-react';
import { Loader2, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApiClient } from '@/lib/api';

interface Workspace {
  id: string;
  name: string;
  clerk_org_id: string;
}

/**
 * WorkspaceGate — wraps the authenticated app shell.
 *
 * If the user belongs to an org but the workspace row doesn't exist yet
 * (e.g. Clerk webhook hasn't fired or was missed), we show a recovery
 * screen instead of a blank 403/500 cascade.
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const { orgId } = useAuth();
  const { apiRequest } = useApiClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<Workspace>({
    queryKey: ['/api/workspaces/me'],
    queryFn: () => apiRequest<Workspace>('GET', '/api/workspaces/me'),
    retry: 1,
    staleTime: 5 * 60 * 1000,
  });

  // No org selected — show Clerk's built-in org creation UI
  if (!orgId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-6">
          <div className="text-center space-y-1">
            <h1 className="text-2xl font-bold">Welcome to Ninja Planner</h1>
            <p className="text-sm text-muted-foreground">
              Create a workspace to get started.
            </p>
          </div>
          <CreateOrganization
            afterCreateOrganizationUrl="/dashboard"
            skipInvitationScreen
          />
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    const message =
      (error as { message?: string })?.message ?? 'Could not load workspace.';
    const isNotFound = message.includes('404') || message.includes('not found');

    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4 max-w-sm px-4">
          <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
          <h2 className="text-lg font-semibold">Workspace not ready</h2>
          <p className="text-sm text-muted-foreground">
            {isNotFound
              ? 'Your workspace is being set up. This usually takes a few seconds after your first sign-in.'
              : message}
          </p>
          <Button
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-2"
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Try again
          </Button>
          <p className="text-xs text-muted-foreground">
            If this persists, try signing out and back in.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
