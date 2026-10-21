// Client IP resolution for rate limiting / vote hashing.
//
// Production chain: Cloudflare -> HAProxy (10.10.1.40) -> nginx (host) -> app container. app.ts
// sets `trust proxy` to ['loopback', 'uniquelocal'] so Express walks X-Forwarded-For past every
// private hop and req.ip becomes the first public address: the Cloudflare edge when proxied
// through Cloudflare, otherwise the real client. When (and only when) that address is a Cloudflare
// edge, CF-Connecting-IP carries the real client IP and can be trusted - anyone else could forge it.
import type { Request } from 'express';
import { BlockList, isIP } from 'net';
import { parseIPv6 } from './ssrf.js';

// https://www.cloudflare.com/ips/ (override with CLOUDFLARE_IP_RANGES, comma-separated CIDRs)
const DEFAULT_CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

let cloudflareList: BlockList | null = null;

function cloudflareRanges(): BlockList {
  if (cloudflareList) return cloudflareList;
  const raw = (process.env.CLOUDFLARE_IP_RANGES ?? '').trim();
  const ranges = raw
    ? raw.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CLOUDFLARE_RANGES;
  const list = new BlockList();
  for (const cidr of ranges) {
    const [net, prefixRaw] = cidr.split('/');
    const family = isIP(net);
    const prefix = Number(prefixRaw);
    if (!family || !Number.isInteger(prefix)) continue;
    try {
      list.addSubnet(net, prefix, family === 6 ? 'ipv6' : 'ipv4');
    } catch {
      /* ignore malformed entry */
    }
  }
  cloudflareList = list;
  return list;
}

/** Strip the IPv4-mapped IPv6 prefix Node reports for IPv4 peers on dual-stack sockets. */
function unmap(ip: string): string {
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : ip;
}

function isCloudflareIp(ip: string): boolean {
  const family = isIP(ip);
  if (!family) return false;
  return cloudflareRanges().check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** Real client IP for rate limiting (see header comment). Never empty. */
export function getClientIp(req: Request): string {
  const ip = unmap(req.ip ?? req.socket?.remoteAddress ?? '');
  if (ip && isCloudflareIp(ip)) {
    const cf = req.headers['cf-connecting-ip'];
    const value = (Array.isArray(cf) ? cf[0] : cf)?.trim();
    if (value && isIP(value)) return unmap(value);
  }
  return ip || 'unknown';
}

/**
 * Rate-limit bucket for an IP: IPv4 as-is, IPv6 collapsed to its /64 (one subscriber typically
 * owns a whole /64, so per-address keys would let a client rotate freely).
 */
export function ipBucket(ip: string): string {
  const addr = unmap(ip);
  if (isIP(addr) !== 6) return addr;
  const groups = parseIPv6(addr);
  if (!groups) return addr;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** Convenience keyGenerator for express-rate-limit. */
export function clientIpKey(req: Request): string {
  return ipBucket(getClientIp(req));
}
