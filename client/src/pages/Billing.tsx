import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Zap, CheckCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApiClient } from '@/lib/api';

interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
  code: string | null;
  expiresAt: string | null;
  adminOverride: boolean;
  reason?: string;
}

export default function Billing() {
  const { apiRequest } = useApiClient();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');

  const { data: status, isLoading } = useQuery<SubscriptionStatus>({
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

  if (isLoading) {
    return (
      <div className="p-6 max-w-xl">
        <div className="h-8 w-48 bg-muted rounded animate-pulse mb-4" />
        <div className="h-48 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  const isActive   = status?.active   ?? false;
  const isExpired  = status?.reason === 'expired';
  const isOverride = status?.adminOverride ?? false;

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          Subscription
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your ninja-stack subscription for plan-ninja.
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
      </Card>

      {/* Activate / renew form */}
      {(!isActive || isExpired) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{isExpired ? 'Renew subscription' : 'Activate subscription'}</CardTitle>
            <CardDescription>
              Enter your ninja-stack subscription code to {isExpired ? 'renew' : 'unlock'} plan-ninja.
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
            {activate.isSuccess && (
              <p className="text-sm text-green-600 mt-2">Subscription activated successfully!</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Already active: show code renewal option */}
      {isActive && !isOverride && (
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
