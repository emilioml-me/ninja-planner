import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Zap, AlertTriangle } from 'lucide-react';
import { useApiClient } from '@/lib/api';

interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
  expiresAt: string | null;
  adminOverride: boolean;
  reason?: string;
}

export function SubscriptionBanner() {
  const { apiRequest } = useApiClient();
  const [, navigate] = useLocation();

  const { data: status, isLoading } = useQuery<SubscriptionStatus>({
    queryKey: ['/api/ninja-stack/status'],
    queryFn: () => apiRequest('GET', '/api/ninja-stack/status'),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading || !status || status.active) return null;

  const isExpired = status.reason === 'expired';

  return (
    <Alert
      className={`rounded-none border-x-0 border-t-0 ${
        isExpired
          ? 'border-destructive/40 bg-destructive/5 text-destructive'
          : 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400'
      }`}
    >
      {isExpired ? (
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      ) : (
        <Zap className="h-4 w-4 mt-0.5 shrink-0" />
      )}
      <AlertDescription className="flex items-center justify-between gap-4 w-full">
        <span className="text-sm">
          {isExpired
            ? 'Your ninja-stack subscription has expired. Renew your code to continue without interruption.'
            : 'Activate your ninja-stack subscription to ensure continued access to plan-ninja.'}
        </span>
        <Button
          size="sm"
          variant="outline"
          className={`shrink-0 ${
            isExpired
              ? 'border-destructive/40 hover:bg-destructive/10'
              : 'border-amber-500/40 hover:bg-amber-500/10'
          }`}
          onClick={() => navigate('/settings/billing')}
        >
          {isExpired ? 'Renew' : 'Activate'}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
