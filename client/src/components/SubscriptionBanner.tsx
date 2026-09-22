import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Zap, AlertTriangle, CloudOff } from 'lucide-react';
import { useApiClient } from '@/lib/api';
import { useIsAdmin } from '@/hooks/use-is-admin';

interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
  expiresAt: string | null;
  adminOverride: boolean;
  reason?: 'no_code' | 'expired' | 'app_not_allowed' | 'revoked' | 'ninja_core_unreachable' | string;
}

type Tone = 'warning' | 'error' | 'info';

/** Banner copy per status reason; `action` is the admin button label (null = no button). */
function describe(reason: SubscriptionStatus['reason'], isAdmin: boolean): { tone: Tone; text: string; action: string | null } {
  const askAdmin = isAdmin ? '' : ' Ask a workspace admin to take care of it.';
  switch (reason) {
    case 'expired':
      return {
        tone: 'error',
        text: `Your ninja-stack subscription has expired. Renew your code to continue without interruption.${askAdmin}`,
        action: 'Renew',
      };
    case 'revoked':
      return {
        tone: 'error',
        text: `This workspace's ninja-stack subscription code was revoked. Activate a valid code to keep using Ninja Planner.${askAdmin}`,
        action: 'Activate',
      };
    case 'app_not_allowed':
      return {
        tone: 'error',
        text: `Your ninja-stack plan doesn't include Ninja Planner. Upgrade your plan or activate a code that includes it.${askAdmin}`,
        action: 'Manage plan',
      };
    case 'ninja_core_unreachable':
      // An outage on our side, not something the customer did wrong.
      return {
        tone: 'info',
        text: "We couldn't verify your subscription right now because the ninja-stack licensing service is unavailable. You can keep working; we'll retry automatically.",
        action: null,
      };
    default:
      return {
        tone: 'warning',
        text: `Activate your ninja-stack subscription to ensure continued access to Ninja Planner.${askAdmin}`,
        action: 'Activate',
      };
  }
}

const TONE_CLASSES: Record<Tone, { alert: string; button: string }> = {
  error: {
    alert: 'border-destructive/40 bg-destructive/5 text-destructive',
    button: 'border-destructive/40 hover:bg-destructive/10',
  },
  warning: {
    alert: 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
    button: 'border-amber-500/40 hover:bg-amber-500/10',
  },
  info: {
    alert: 'border-muted-foreground/30 bg-muted/40 text-muted-foreground',
    button: '',
  },
};

export function SubscriptionBanner() {
  const { apiRequest } = useApiClient();
  const [, navigate] = useLocation();
  const isAdmin = useIsAdmin();

  const { data: status, isLoading } = useQuery<SubscriptionStatus>({
    queryKey: ['/api/ninja-stack/status'],
    queryFn: () => apiRequest('GET', '/api/ninja-stack/status'),
    staleTime: 10 * 60 * 1000,
  });

  if (isLoading || !status || status.active) return null;

  const { tone, text, action } = describe(status.reason, isAdmin);
  const classes = TONE_CLASSES[tone];
  const Icon = tone === 'error' ? AlertTriangle : tone === 'info' ? CloudOff : Zap;

  return (
    <Alert className={`rounded-none border-x-0 border-t-0 ${classes.alert}`}>
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <AlertDescription className="flex items-center justify-between gap-4 w-full">
        <span className="text-sm">{text}</span>
        {/* Activation is admin-only on the server; don't offer the button to members. */}
        {isAdmin && action && (
          <Button
            size="sm"
            variant="outline"
            className={`shrink-0 ${classes.button}`}
            onClick={() => navigate('/settings/billing')}
          >
            {action}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
