import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '@/lib/api';
import type { IntegrationsSummary, IntegrationsStatus } from '@/types/integrations';

export type { IntegrationsSummary, IntegrationsStatus };

export function useIntegrationsSummary() {
  const { apiRequest } = useApiClient();
  return useQuery<IntegrationsSummary>({
    queryKey: ['/api/integrations/summary'],
    queryFn: () => apiRequest<IntegrationsSummary>('GET', '/api/integrations/summary'),
    staleTime: 5 * 60 * 1000, // matches server cache TTL
    retry: false,              // don't retry — graceful fallback is the point
  });
}

export function useIntegrationsStatus() {
  const { apiRequest } = useApiClient();
  return useQuery<IntegrationsStatus>({
    queryKey: ['/api/integrations/status'],
    queryFn: () => apiRequest<IntegrationsStatus>('GET', '/api/integrations/status'),
    staleTime: 10 * 60 * 1000,
  });
}
