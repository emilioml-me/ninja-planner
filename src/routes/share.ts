import { Router } from 'express';
import { z } from 'zod';
import { createHash, createHmac } from 'crypto';
import rateLimit from 'express-rate-limit';
import {
  getPublicRoadmap,
  validateShareToken,
  addRoadmapVote,
  removeRoadmapVote,
  type VoteResult,
} from '../services/shareService.js';
import { getClientIp, ipBucket } from '../lib/clientIp.js';

/**
 * C1/L27: the network a vote is attributed to - the real client IP (Cloudflare-aware, see
 * lib/clientIp) with IPv6 collapsed to its /64, so rotating addresses inside one IPv6 allocation
 * doesn't reset the per-network vote cap.
 */
function voterNetwork(req: import('express').Request): string | undefined {
  const ip = getClientIp(req);
  return ip ? ipBucket(ip) : undefined;
}

/**
 * Key for hashing voter IPs. A plain SHA-256 of an IPv4 address is trivially reversible by
 * enumerating the address space, so the hash is an HMAC keyed with a server secret:
 * VOTE_IP_HASH_SECRET when set, otherwise a key derived from CLERK_SECRET_KEY (always present in
 * a working deployment). Resolved lazily so it reads env after dotenv has loaded.
 */
let ipHashKey: string | null = null;
function getIpHashKey(): string {
  if (ipHashKey) return ipHashKey;
  const explicit = process.env.VOTE_IP_HASH_SECRET;
  if (explicit) {
    ipHashKey = explicit;
  } else {
    const base = process.env.CLERK_SECRET_KEY;
    if (!base) throw new Error('VOTE_IP_HASH_SECRET or CLERK_SECRET_KEY must be set');
    ipHashKey = createHmac('sha256', base).update('ninja-planner:roadmap-vote-ip-hash').digest('hex');
  }
  return ipHashKey;
}

/** Salted HMAC of the client IP - raw IPs are never stored or logged. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHmac('sha256', getIpHashKey()).update(ip).digest('hex');
}

/** Pre-salt format (plain SHA-256), only used to let visitors retract votes cast before the switch. */
function legacyHashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex');
}

function sendVoteResult(res: import('express').Response, result: VoteResult): void {
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  if (result.status === 'ip_limit') {
    res.status(429).json({ error: 'Vote limit reached for this network', vote_count: result.vote_count });
    return;
  }
  // `changed` tells the client whether this call actually added/removed a vote (false when the
  // visitor had already voted / had no vote), so it only flips its local "voted" state on a change.
  res.json({ vote_count: result.vote_count, changed: result.changed });
}

/**
 * Public routes — no auth required.
 * Mounted at /public in index.ts (before requireAuth middleware).
 */
const router = Router();

// Tight rate limit on vote endpoints to prevent visitor_id rotation abuse.
// 20 votes/min per IP; much lower than the global 200/min.
const voteLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(getClientIp(req)),
  message: { error: 'Too many votes, please try again later' },
});

// Same intent as voteLimiter: an unauthenticated, token-gated endpoint that can leak roadmap
// data per successful token guess, previously relying solely on the app-wide 200/min limiter.
const publicReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(getClientIp(req)),
  message: { error: 'Too many requests' },
});

const voteBodySchema = z.object({
  visitor_id: z.string().trim().min(1).max(128),
});
const itemIdSchema = z.string().uuid();

// GET /public/roadmap/:token
router.get('/roadmap/:token', publicReadLimiter, async (req, res, next) => {
  try {
    const data = await getPublicRoadmap(req.params.token);
    if (!data) {
      res.status(404).json({ error: 'Roadmap not found or link expired' });
      return;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /public/roadmap/:token/votes/:itemId
router.post('/roadmap/:token/votes/:itemId', voteLimiter, async (req, res, next) => {
  try {
    const parsed = voteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (!itemIdSchema.safeParse(req.params.itemId).success) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    const workspaceId = await validateShareToken(req.params.token, 'roadmap');
    if (!workspaceId) {
      res.status(404).json({ error: 'Roadmap not found or link expired' });
      return;
    }
    const ipHash = hashIp(voterNetwork(req));
    if (!ipHash) {
      res.status(400).json({ error: 'Unable to process vote: client IP could not be determined' });
      return;
    }
    const result = await addRoadmapVote(req.params.itemId, workspaceId, parsed.data.visitor_id, ipHash);
    sendVoteResult(res, result);
  } catch (err) {
    next(err);
  }
});

// DELETE /public/roadmap/:token/votes/:itemId
router.delete('/roadmap/:token/votes/:itemId', voteLimiter, async (req, res, next) => {
  try {
    const parsed = voteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (!itemIdSchema.safeParse(req.params.itemId).success) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    const workspaceId = await validateShareToken(req.params.token, 'roadmap');
    if (!workspaceId) {
      res.status(404).json({ error: 'Roadmap not found or link expired' });
      return;
    }
    const network = voterNetwork(req);
    const ipHash = hashIp(network);
    if (!ipHash) {
      res.status(400).json({ error: 'Unable to process vote: client IP could not be determined' });
      return;
    }
    const result = await removeRoadmapVote(
      req.params.itemId, workspaceId, parsed.data.visitor_id, ipHash, legacyHashIp(network),
    );
    sendVoteResult(res, result);
  } catch (err) {
    next(err);
  }
});

export default router;
