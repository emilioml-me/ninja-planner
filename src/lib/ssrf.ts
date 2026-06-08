// Matches loopback, RFC-1918, link-local, IPv6 ULA, and unspecified addresses
export const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1$|fd[0-9a-f]{2}:|0\.0\.0\.0)$/i;

// Blocks localhost, .local/.internal/.lan TLDs, bare cloud metadata hostnames,
// and common cloud provider internal endpoints.
export const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.lan|metadata|instance-data|computemetadata|169\.254\.169\.254)$/i;

export function isSafeWebhookUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (PRIVATE_HOST_RE.test(hostname)) return false;
    if (PRIVATE_IP_RE.test(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function resolvedIpIsSafe(hostname: string): Promise<boolean> {
  const { lookup } = await import('dns/promises');
  try {
    const { address } = await lookup(hostname);
    return !PRIVATE_IP_RE.test(address);
  } catch {
    return false;
  }
}
