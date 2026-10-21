import { useAuth } from '@clerk/clerk-react';

/**
 * Error thrown by apiRequest for non-2xx responses. `message` is a human-readable string
 * (never "[object Object]" and without the HTTP status prefix); callers that need to branch on
 * the status (e.g. 404 handling) should check `status` instead of parsing the message.
 */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Turns a server error payload into a readable message. Handles:
 * - `{ error: 'text' }`
 * - `{ error: { formErrors: string[], fieldErrors: Record<string, string[]> } }` (zod flatten())
 * - `{ error: { message: 'text' } }` / `{ message: 'text' }`
 */
export function formatApiError(body: unknown, fallback: string): string {
  if (body == null) return fallback;
  if (typeof body === 'string') return body.trim() || fallback;
  if (typeof body !== 'object') return String(body);

  const obj = body as Record<string, unknown>;
  const err = 'error' in obj ? obj.error : obj;

  // `{ error: 'Invalid request', details: <flatten() | issues[]> }` - show the field messages
  // instead of only the generic summary.
  if (typeof err === 'string' && obj.details && typeof obj.details === 'object') {
    const detail = Array.isArray(obj.details)
      ? obj.details
          .map((i) => {
            const issue = i as { path?: unknown; message?: unknown };
            if (typeof issue?.message !== 'string') return '';
            const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .filter(Boolean)
          .join('; ')
      : formatApiError({ error: obj.details }, '');
    if (detail) return err.trim() ? `${err.trim()}: ${detail}` : detail;
  }

  if (typeof err === 'string') return err.trim() || fallback;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [];
    if (Array.isArray(e.formErrors)) {
      for (const m of e.formErrors) if (typeof m === 'string' && m) parts.push(m);
    }
    if (e.fieldErrors && typeof e.fieldErrors === 'object') {
      for (const [field, msgs] of Object.entries(e.fieldErrors as Record<string, unknown>)) {
        const list = Array.isArray(msgs) ? msgs.filter((m) => typeof m === 'string' && m) : [];
        if (list.length > 0) parts.push(`${field}: ${list.join(', ')}`);
      }
    }
    if (parts.length > 0) return parts.join('; ');
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  if (typeof obj.message === 'string' && obj.message) return obj.message;
  return fallback;
}

/** The browser's IANA timezone (e.g. 'America/Mexico_City'), or '' when unavailable. */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * Headers every request to our API should carry. X-Timezone lets the server compute "today" and
 * date-of-timestamp buckets in the user's local calendar instead of UTC. Use it for raw fetch()
 * calls too (public pages that don't go through useApiClient).
 */
export function baseHeaders(): Record<string, string> {
  const tz = getBrowserTimeZone();
  return tz ? { 'X-Timezone': tz } : {};
}

export function useApiClient() {
  const { getToken } = useAuth();

  async function send(method: string, url: string, data?: unknown): Promise<Response> {
    const token = await getToken();
    if (!token) throw new Error('Session expired — please sign in again');

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...baseHeaders(),
          ...(data != null ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${token}`,
        },
        body: data != null ? JSON.stringify(data) : undefined,
      });
    } catch {
      throw new Error('Network error — please check your connection');
    }

    if (!res.ok) {
      const fallback = res.statusText || `Request failed (${res.status})`;
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, formatApiError(body, fallback), body);
    }
    return res;
  }

  async function apiRequest<T = unknown>(
    method: string,
    url: string,
    data?: unknown,
  ): Promise<T> {
    const res = await send(method, url, data);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  /** Like apiRequest, but also returns the response headers (e.g. X-Total-Count). */
  async function apiRequestWithHeaders<T = unknown>(
    method: string,
    url: string,
    data?: unknown,
  ): Promise<{ data: T; headers: Headers }> {
    const res = await send(method, url, data);
    const body = res.status === 204 ? (undefined as T) : ((await res.json()) as T);
    return { data: body, headers: res.headers };
  }

  return { apiRequest, apiRequestWithHeaders };
}
