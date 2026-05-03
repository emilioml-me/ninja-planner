import { logger } from '../config/logger.js';

/**
 * Send a plain-text message to the configured Slack webhook.
 * Silently no-ops if SLACK_WEBHOOK_URL is not set.
 * Never throws — failures are logged as warnings only.
 */
export async function sendSlackMessage(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Slack webhook returned non-OK status');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to send Slack notification');
  }
}
