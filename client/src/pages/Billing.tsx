import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Zap, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApiClient } from '@/lib/api';
import { useIsAdmin, useIsAdminLoaded } from '@/hooks/use-is-admin';
import { QueryError } from '@/components/QueryError';

interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
  expiresAt: string | null;
  adminOverride: boolean;
  reason?: string;
}

/** Human text for the server's inactive `reason` codes (subscriptionService). */
const REASON_TEXT: Record<string, string> = {
  no_code: 'No subscription code has been entered for this workspace yet.',
  expired: 'The subscription has expired.',
  app_not_allowed: "The current plan doesn't include Ninja Planner.",
  revoked: 'The subscription code was revoked or is no longer valid.',
  ninja_core_unreachable: "The subscription service couldn't be reached to confirm the subscription. Try again in a few minutes.",
};

function reasonText(reason: string | undefined): string | null {
  if (!reason) return null;
  return REASON_TEXT[reason] ?? `Reason: ${reason}`;
}

export default function Billing() {
  const { apiRequest } = useApiClient();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  // Activation is admin-only on the server (403 otherwise) — don't offer the form to members.
  const isAdmin = useIsAdmin();
  const isAdminLoaded = useIsAdminLoaded();

  const { data: status, isLoading, isError, error, refetch } = useQuery<SubscriptionStatus>({
    queryKey: ['/api/ninja-stack/status'],
    queryFn: () => apiRequest('GET', '/api/ninja-stack/status'),
  });

  const activate = useMutation<SubscriptionStatus, Error, string>({
    mutationFn: (c) => apiRequest('POST', '/api/ninja-stack/activate', { code: c }),
    onSuccess: (data) => {
      queryClient.setQueryData(['/api/ninja-stack/status'], data);
      setCode('');
    },
  });

  if (isLoading || !isAdminLoaded) {
    return (
      <div className="p-6 max-w-xl">
        <div className="h-8 w-48 bg-muted rounded animate-pulse mb-4" />
        <div className="h-48 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  // A failed status fetch must not look like "No active subscription" (and offer activation) to
  // a paying workspace.
  if (isError && !status) {
    return (
      <div className="p-6 max-w-xl space-y-6">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Subscription
        </h1>
        <QueryError error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  const isActive   = status?.active   ?? false;
  const isExpired  = status?.reason === 'expired';
  const isOverride = status?.adminOverride ?? false;
  const inactiveReason = !isActive ? reasonText(status?.reason) : null;
  // The result of the last activation attempt, shown on whichever card is visible afterwards
  // (a successful activation hides the activation form, so its message must live elsewhere).
  const activationMessage = activate.isSuccess
    ? (activate.data?.active
        ? { ok: true, text: 'Subscription activated successfully!' }
        : { ok: false, text: reasonText(activate.data?.reason) ?? 'The code was accepted but the subscription is not active.' })
    : null;

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Subscription
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your ninja-stack subscription for Ninja Planner.
        </p>
      </div>

      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            {isActive ? (
              <>
                <CheckCircle className="h-4 w-4 text-green-500" />
                Subscription active
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                {isExpired ? 'Subscription expired' : 'No active subscription'}
              </>
            )}
          </CardTitle>
          {status?.plan && (
            <CardDescription className="flex items-center gap-2 mt-1">
              Plan:
              <Badge variant="secondary" className="capitalize">{status.plan}</Badge>
              {isOverride && <Badge variant="outline" className="text-xs">Admin Override</Badge>}
            </CardDescription>
          )}
        </CardHeader>
        {(isActive && status?.expiresAt) && (
          <CardContent className="pt-0 text-sm text-muted-foreground">
            Expires: {new Date(status.expiresAt).toLocaleDateString('en-US', { dateStyle: 'long' })}
          </CardContent>
        )}
        {inactiveReason && (
          <CardContent className="pt-0 text-sm text-muted-foreground">{inactiveReason}</CardContent>
        )}
        {activationMessage && (
          <CardContent className={`pt-0 text-sm ${activationMessage.ok ? 'text-green-600' : 'text-destructive'}`} role="status">
            {activationMessage.text}
          </CardContent>
        )}
      </Card>

      {!isAdmin && (!isActive || isExpired) && (
        <p className="text-sm text-muted-foreground">
          Ask a workspace admin to {isExpired ? 'renew' : 'activate'} the subscription.
        </p>
      )}

      {/* Activate / renew form */}
      {isAdmin && (!isActive || isExpired) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{isExpired ? 'Renew subscription' : 'Activate subscription'}</CardTitle>
            <CardDescription>
              Enter your ninja-stack subscription code to {isExpired ? 'renew' : 'unlock'} Ninja Planner.
              {' '}
              <a
                href="https://ninja-core.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                Get a code at ninja-core.com <ExternalLink className="h-3 w-3" />
              </a>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) activate.mutate(code.trim());
              }}
            >
              <div className="flex-1">
                <Label htmlFor="sub-code" className="sr-only">Subscription code</Label>
                <Input
                  id="sub-code"
                  placeholder="nsk_xxxxxxxx"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button type="submit" disabled={activate.isPending || !code.trim()}>
                {activate.isPending ? 'Checking…' : 'Activate'}
              </Button>
            </form>
            {activate.isError && (
              <p className="text-sm text-destructive mt-2">
                {activate.error.message || 'Invalid code. Please try again.'}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Already active: show code renewal option */}
      {isAdmin && isActive && !isOverride && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Update subscription code</CardTitle>
            <CardDescription>Enter a new code to switch plans or extend your subscription.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) activate.mutate(code.trim());
              }}
            >
              <div className="flex-1">
                <Input
                  placeholder="nsk_xxxxxxxx"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button type="submit" disabled={activate.isPending || !code.trim()}>
                {activate.isPending ? 'Checking…' : 'Update'}
              </Button>
            </form>
            {activate.isError && (
              <p className="text-sm text-destructive mt-2">{activate.error.message}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
