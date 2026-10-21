import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, formatApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Readable message for a query/mutation error (ApiError messages are already formatted). */
export function queryErrorMessage(error: unknown, fallback = 'Something went wrong while loading this data.'): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return formatApiError(error, fallback);
}

interface QueryErrorProps {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}

/**
 * Compact "couldn't load" card for a failed query. Render it when `isError && !data`, so a
 * failure isn't mistaken for an empty list ("No X yet"); when a background refetch fails but
 * stale data exists, keep showing the data instead.
 */
export function QueryError({ error, onRetry, className }: QueryErrorProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center',
        className,
      )}
    >
      <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Couldn't load this data</p>
        <p className="text-sm text-muted-foreground break-words">{queryErrorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" className="gap-2" onClick={() => onRetry()}>
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </Button>
      )}
    </div>
  );
}
