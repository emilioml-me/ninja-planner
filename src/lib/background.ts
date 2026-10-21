// Registry of in-flight fire-and-forget work (webhook dispatch, automations, emails) so graceful
// shutdown can wait for it instead of dropping it mid-flight on SIGTERM.
import { logger } from '../config/logger.js';

const inFlight = new Set<Promise<unknown>>();

/**
 * Track a background promise until it settles. Returns the same promise so callers can keep
 * chaining (`trackBackground(fireWebhooks(...)).catch(...)`). Rejections are not swallowed for
 * the caller, but the registry itself never produces an unhandled rejection.
 */
export function trackBackground<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  p.then(
    () => { inFlight.delete(p); },
    () => { inFlight.delete(p); },
  );
  return p;
}

export function backgroundCount(): number {
  return inFlight.size;
}

/** Wait for tracked work to settle, up to `timeoutMs`. Never throws. */
export async function drainBackground(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Work started while draining (e.g. a webhook retry scheduling more work) is picked up too.
  while (inFlight.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logger.warn({ pending: inFlight.size }, 'Background work still pending at shutdown deadline');
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
