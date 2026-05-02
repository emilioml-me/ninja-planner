import { useAuth } from '@clerk/clerk-react';

export function useApiClient() {
  const { getToken } = useAuth();

  async function apiRequest<T = unknown>(
    method: string,
    url: string,
    data?: unknown,
  ): Promise<T> {
    const token = await getToken();
    if (!token) throw new Error('Session expired — please sign in again');

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
    } catch {
      throw new Error('Network error — please check your connection');
    }

    if (!res.ok) {
      let message: string;
      try {
        const body = await res.json() as { error?: string };
        message = body.error ?? res.statusText;
      } catch {
        message = res.statusText;
      }
      throw new Error(`${res.status}: ${message}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  return { apiRequest };
}
