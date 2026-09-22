// Matches loopback, RFC-1918, link-local, IPv6 ULA, and unspecified addresses.
//
// Two bugs fixed here: (a) `new URL().hostname` returns IPv6 literals WITH brackets (e.g.
// "[::1]"), which the old alternatives never accounted for — normalizeHostForIpCheck now strips
// brackets before this regex ever sees the hostname; and (b) the old `fd[0-9a-f]{2}:` required
// the ENTIRE hostname to be exactly the 5 characters "fd00:" (this whole regex is ^...$
// anchored) — no real ULA address, which continues with more groups (e.g.
// "fd12:3456:789a::1"), could ever match it, so IPv6 ULA/link-local addresses reached via a
// resolvable hostname (not just a literal) passed through unblocked. Replaced with proper
// prefix-based alternatives for ULA (fc00::/7) and link-local (fe80::/10).
export const PRIVATE_IP_RE = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|::1|::|f[cd][0-9a-f]{0,2}:[0-9a-f:]*|fe[89ab][0-9a-f]?:[0-9a-f:]*)$/i;

// Blocks localhost, .local/.internal/.lan TLDs, bare cloud metadata hostnames,
// and common cloud provider internal endpoints.
export const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.lan|metadata|instance-data|computemetadata|169\.254\.169\.254)$/i;

/**
 * Normalizes alternate IPv4 encodings (decimal, octal, hex, short forms, and
 * IPv4-mapped IPv6) to dotted-quad so PRIVATE_IP_RE can't be bypassed by
 * e.g. http://2130706433/ or http://::ffff:127.0.0.1/ resolving to 127.0.0.1.
 */
export function normalizeHostForIpCheck(hostnameRaw: string): string {
  // `new URL().hostname` returns IPv6 literals WITH brackets (e.g. "[::1]") — strip them so
  // every check below (and PRIVATE_IP_RE, called by the caller on our return value) operates on
  // the bare address instead of silently never matching a bracketed string.
  const hostname = hostnameRaw.replace(/^\[|\]$/g, '');

  const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];

  // IPv4-mapped IPv6 in hex form (e.g. ::ffff:7f00:1 for 127.0.0.1) — convert the trailing two
  // hex groups (32 bits) to dotted-quad so the IPv4 alternatives in PRIVATE_IP_RE catch it,
  // rather than leaving it as a string none of the IPv6 alternatives are shaped to match either.
  const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
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

// ── Structured IP classification ─────────────────────────────────────────────
//
// PRIVATE_IP_RE above only covers the common ranges. isPrivateIp() parses the address and checks
// the full set of non-public ranges, including CGNAT (100.64.0.0/10), 0.0.0.0/8, benchmarking
// (198.18.0.0/15), documentation, multicast/reserved, and IPv6 forms that embed an IPv4 address
// (IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16).

function parseIPv4(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

function isPrivateIPv4(p: number[]): boolean {
  const [a, b, c] = p;
  if (a === 0) return true;                                // 0.0.0.0/8 "this network"
  if (a === 10) return true;                               // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true;       // 100.64/10 CGNAT
  if (a === 127) return true;                              // loopback
  if (a === 169 && b === 254) return true;                 // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true;        // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true;        // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true;      // 6to4 relay anycast
  if (a === 192 && b === 168) return true;                 // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true;    // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true;     // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true;      // TEST-NET-3
  if (a >= 224) return true;                               // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

/** Expand an IPv6 literal (optionally with trailing dotted IPv4) into 8 16-bit groups. */
function parseIPv6(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (!ip.includes(':')) return null;
  // Trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) -> two hex groups
  const v4m = ip.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4m) {
    const v4 = parseIPv4(v4m[2]);
    if (!v4) return null;
    ip = v4m[1] + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

function embeddedV4(hi: number, lo: number): number[] {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isPrivateIPv6(g: number[]): boolean {
  const first96Zero = g.slice(0, 6).every((n) => n === 0);
  if (first96Zero) return true;                                            // ::, ::1, IPv4-compatible ::/96
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {            // IPv4-mapped ::ffff:0:0/96
    return isPrivateIPv4(embeddedV4(g[6], g[7]));
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b) {
    if (g.slice(2, 6).every((n) => n === 0)) return isPrivateIPv4(embeddedV4(g[6], g[7])); // NAT64 64:ff9b::/96
    if (g[2] === 0x0001) return true;                                       // 64:ff9b:1::/48 local-use NAT64
  }
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedV4(g[1], g[2]));       // 6to4 2002::/16
  if (g[0] === 0x2001 && g[1] === 0x0000) return true;                     // Teredo 2001::/32
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;                     // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return true;                             // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true;                             // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true;                             // site-local fec0::/10 (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true;                             // multicast ff00::/8
  return false;
}

/**
 * True if `address` (IPv4 or IPv6 literal, alternate IPv4 encodings accepted) is anything other
 * than a public unicast address. Unparseable input is treated as private (fail closed).
 */
export function isPrivateIp(address: string): boolean {
  const normalized = normalizeHostForIpCheck(address);
  const v4 = parseIPv4(normalized);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(normalized);
  if (v6) return isPrivateIPv6(v6);
  return true;
}

/** True if `host` is an IP literal (any encoding), as opposed to a DNS name. */
function looksLikeIpLiteral(host: string): boolean {
  const normalized = normalizeHostForIpCheck(host);
  return parseIPv4(normalized) !== null || parseIPv6(normalized) !== null;
}

export function isSafeWebhookUrl(raw: string): boolean {
  try {
    const { protocol, hostname } = new URL(raw);
    if (protocol !== 'https:' && protocol !== 'http:') return false;
    if (PRIVATE_HOST_RE.test(hostname)) return false;
    const normalized = normalizeHostForIpCheck(hostname);
    if (PRIVATE_IP_RE.test(normalized)) return false;
    if (looksLikeIpLiteral(hostname) && isPrivateIp(hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `hostname` and require EVERY returned address to be public. Checking only the first
 * address (the old behaviour) let a hostname with mixed A/AAAA records pass while fetch() could
 * connect to a private one.
 */
export async function resolvedIpIsSafe(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (looksLikeIpLiteral(host)) return !isPrivateIp(host);
  const { lookup } = await import('dns/promises');
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every(({ address }) => !isPrivateIp(address));
  } catch {
    return false;
  }
}
