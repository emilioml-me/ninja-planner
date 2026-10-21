import { logger } from '../config/logger.js';
import { isOperatorWorkspace } from './operator.js';

/** Slack mrkdwn escaping — only &, < and > are control characters. */
function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send a plain-text message to the configured Slack webhook.
 *
 * SLACK_WEBHOOK_URL is a single global (operator-owned) channel, so messages are only sent for
 * operator workspaces (see OPERATOR_WORKSPACE_IDS) — otherwise one tenant's task/review titles
 * would leak into the operator's Slack. Silently no-ops if SLACK_WEBHOOK_URL is not set.
 * Never throws — failures are logged as warnings only. Resolves true only when Slack answered
 * 2xx; false when skipped (no URL / non-operator workspace) or on any failure.
 */
export async function sendSlackMessage(text: string, workspaceId: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  if (!isOperatorWorkspace(workspaceId)) return false;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: escapeSlack(text) }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Slack webhook returned non-OK status');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'Failed to send Slack notification');
    return false;
  }
}
