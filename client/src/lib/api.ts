import { useAuth } from '@clerk/clerk-react';

export function useApiClient() {
  const { getToken } = useAuth();

  async function apiRequest<T = unknown>(
    method: string,
    url: string,
    data?: unknown,
  ): Promise<T> {
    const token = await getToken();
    const res = await fetch(url, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!res.ok) {
      const text = (await res.text()) || res.statusText;
      throw new Error(`${res.status}: ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  return { apiRequest };
}
