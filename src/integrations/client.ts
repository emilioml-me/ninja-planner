import { logger } from '../config/logger.js';
import type { IntegrationResult } from './types.js';

export interface ServiceConfig {
  url: string;   // base URL, no trailing slash
  apiKey: string;
}

/**
 * Resolve a service config from env vars by prefix.
 * e.g. prefix = 'CRM_NINJA' reads CRM_NINJA_URL + CRM_NINJA_API_KEY
 */
export function getServiceConfig(envPrefix: string): ServiceConfig | null {
  const url    = process.env[`${envPrefix}_URL`];
  const apiKey = process.env[`${envPrefix}_API_KEY`];
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/$/, ''), apiKey };
}

/**
 * Make a GET request to an internal ninja service.
 * Returns the parsed JSON body or throws on non-2xx / timeout.
 */
export async function fetchFromService<T>(
  config: ServiceConfig,
  path: string,
  timeoutMs = 5_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.url}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Accept': 'application/json',
        'X-Ninja-Service': 'ninja-planner',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    return await res.json() as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`Request to ${config.url}${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps fetchFromService in an IntegrationResult — never throws.
 * If config is null → not configured.
 * If fetch fails → configured but error captured.
 */
export async function safeIntegrationFetch<T>(
  envPrefix: string,
  path: string,
  timeoutMs = 5_000,
): Promise<IntegrationResult<T>> {
  const config = getServiceConfig(envPrefix);

  if (!config) {
    return { configured: false, data: null, error: null };
  }

  try {
    const data = await fetchFromService<T>(config, path, timeoutMs);
    return { configured: true, data, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ envPrefix, path, err: message }, 'Integration fetch failed');
    return { configured: true, data: null, error: message };
  }
}
