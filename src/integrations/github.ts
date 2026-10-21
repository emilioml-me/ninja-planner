import { logger } from '../config/logger.js';

// Owner/repo segments are restricted to GitHub's own name charset; '.' and '..' are rejected
// separately so a crafted ref can't path-traverse to another API endpoint.
const GITHUB_ISSUE_URL_RE = /^https?:\/\/github\.com\/([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})\/issues\/(\d{1,9})\/?$/i;

export function parseGithubIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } | null {
  const match = GITHUB_ISSUE_URL_RE.exec(url.trim());
  if (!match) return null;
  const [, owner, repo, num] = match;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  const issueNumber = parseInt(num, 10);
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return null;
  return { owner, repo, issueNumber };
}

/**
 * Fetches a GitHub issue's open/closed state.
 *
 * GITHUB_TOKEN is the platform operator's credential and can read the operator's private repos,
 * so it is only sent when `useToken` is true (callers pass isOperatorWorkspace(...)). Every other
 * workspace queries GitHub unauthenticated, i.e. can only see public issues — otherwise any tenant
 * admin could probe the existence/state of issues in the operator's private repos.
 * Returns null on any failure (not found, private, rate-limited, network) without distinguishing.
 */
export async function fetchGithubIssueStatus(
  url: string,
  opts: { useToken: boolean } = { useToken: false },
): Promise<{ state: 'open' | 'closed'; title: string } | null> {
  const parsed = parseGithubIssueUrl(url);
  if (!parsed) return null;

  const token = opts.useToken ? process.env.GITHUB_TOKEN : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/issues/${parsed.issueNumber}`,
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
    const data = await res.json() as { state?: unknown; title?: unknown };
    if (data.state !== 'open' && data.state !== 'closed') return null;
    return { state: data.state, title: typeof data.title === 'string' ? data.title : '' };
  } catch (err) {
    logger.warn({ url, err }, '[github] issue fetch error');
    return null;
  } finally {
    clearTimeout(timer);
  }
}
