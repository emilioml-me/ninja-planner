// Matches loopback, RFC-1918, link-local, IPv6 ULA, and unspecified addresses
export const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|::1$|fd[0-9a-f]{2}:|0\.0\.0\.0)$/i;

// Blocks localhost, .local/.internal/.lan TLDs, bare cloud metadata hostnames,
// and common cloud provider internal endpoints.
export const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.lan|metadata|instance-data|computemetadata|169\.254\.169\.254)$/i;

/**
 * Normalizes alternate IPv4 encodings (decimal, octal, hex, short forms, and
 * IPv4-mapped IPv6) to dotted-quad so PRIVATE_IP_RE can't be bypassed by
 * e.g. http://2130706433/ or http://::ffff:127.0.0.1/ resolving to 127.0.0.1.
 */
export function normalizeHostForIpCheck(hostname: string): string {
  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (/^::ffff:[0-9a-f:]+$/i.test(hostname)) {
    // IPv4-mapped IPv6 in hex form (::ffff:7f00:1) — let the private-range check below handle it
    return hostname;
  }

  // Pure-decimal or dotted numeric/octal/hex hostnames are interpreted as IPv4 by getaddrinfo
  // on many platforms — normalize to dotted-quad so the regex above catches them.
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)(\.(0x[0-9a-f]+|0[0-7]*|[1-9]\d*|0)){0,3}$/i.test(hostname)) {
    const parts = hostname.split('.');
    const toNum = (s: string): number | null => {
      if (/^0x/i.test(s)) return parseInt(s, 16);
      if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      return null;
    };
    const nums = parts.map(toNum);
    if (nums.every((n) => n !== null && Number.isFinite(n) && n >= 0)) {
      let value: number;
      if (nums.length === 4) {
        if (nums.some((n) => (n as number) > 255)) return hostname;
        value = ((nums[0] as number) << 24) + ((nums[1] as number) << 16) + ((nums[2] as number) << 8) + (nums[3] as number);
      } else if (nums.length === 1) {
        value = nums[0] as number;
      } else {
        return hostname; // ambiguous short forms (a.b, a.b.c) — leave as-is, still blocked if it looks private
      }
      if (value >= 0 && value <= 0xffffffff) {
        return [
          (value >>> 24) & 0xff,
          (value >>> 16) & 0xff,
          (value >>> 8) & 0xff,
          value & 0xff,
        ].join('.');
      }
    }
  }
  return hostname;
}

export function isSafeWebhookUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (PRIVATE_HOST_RE.test(hostname)) return false;
    const normalized = normalizeHostForIpCheck(hostname);
    if (PRIVATE_IP_RE.test(normalized)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function resolvedIpIsSafe(hostname: string): Promise<boolean> {
  const { lookup } = await import('dns/promises');
  try {
    const { address } = await lookup(hostname);
    return !PRIVATE_IP_RE.test(normalizeHostForIpCheck(address));
  } catch {
    return false;
  }
}
