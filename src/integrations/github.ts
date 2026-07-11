import { logger } from '../config/logger.js';

const GITHUB_ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i;

export function parseGithubIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
  const match = GITHUB_ISSUE_URL_RE.exec(url.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: parseInt(match[3], 10) };
}

/**
 * Fetches a GitHub issue's open/closed state. Uses GITHUB_TOKEN if set (higher rate limit,
 * required for private repos); falls back to unauthenticated requests for public repos.
 */
export async function fetchGithubIssueStatus(url: string): Promise<{ state: 'open' | 'closed'; title: string } | null> {
  const parsed = parseGithubIssueUrl(url);
  if (!parsed) return null;

  const token = process.env.GITHUB_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.issueNumber}`,
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      logger.warn({ url, status: res.status }, '[github] issue fetch failed');
      return null;
    }
    const data = await res.json() as { state: 'open' | 'closed'; title: string };
    return { state: data.state, title: data.title };
  } catch (err) {
    logger.warn({ url, err }, '[github] issue fetch error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
