import { Router } from 'express';
import { z }      from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool }             from '../config/db.js';
import { clerkClient }      from '../config/clerk.js';
import { logger }           from '../config/logger.js';
import rateLimit            from 'express-rate-limit';
import { getClientIp, ipBucket } from '../lib/clientIp.js';

const router = Router();
router.use(requireWorkspace);

// L25: per-user cap on ticket creation (each call creates a real ticket upstream). Keyed by the
// authenticated Clerk user, not IP - requireWorkspace has already run, so req.auth is set.
const ticketLimiter = rateLimit({
  windowMs: 10 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.auth?.userId ?? ipBucket(getClientIp(req))}`,
  message: { error: 'Too many support requests. Please wait a few minutes and try again.' },
});

const ticketSchema = z.object({
  subject:     z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
});

/** Messages for upstream 4xx statuses - desk-ninja's own error text is never forwarded. */
function upstreamClientError(status: number): string {
  if (status === 429) return 'Support request limit reached. Please try again later.';
  if (status === 413) return 'Your message is too long.';
  return 'The support request could not be created. Please check your message and try again.';
}

// POST /api/support/ticket
// Proxies to desk-ninja /api/v1/tickets on behalf of the calling user.
router.post('/ticket', ticketLimiter, async (req, res, next) => {
  try {
    const parsed = ticketSchema.safeParse(req.body);
    if (!parsed.success) {
      // Same 400 shape as every other route: { error: <zod flatten()> }.
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const apiKey      = process.env.DESK_NINJA_API_KEY;
    const deskNinjaUrl = process.env.DESK_NINJA_URL ?? 'https://desk-ninja.com';

    if (!apiKey) {
      return res.status(503).json({ error: 'Support is not available right now. Please email support directly.' });
    }

    // Look up the calling user's name + email — DB first, Clerk as fallback
    const memberResult = await pool.query<{ display_name: string | null; email: string | null }>(
      `SELECT display_name, email FROM workspace_members
       WHERE workspace_id = $1 AND clerk_user_id = $2`,
      [req.workspace.id, req.auth.userId],
    );
    let memberEmail = memberResult.rows[0]?.email ?? null;
    let memberName  = memberResult.rows[0]?.display_name ?? null;

    if (!memberEmail) {
      // Fallback: fetch from Clerk (handles existing members before migration 024)
      try {
        const clerkUser = await clerkClient.users.getUser(req.auth.userId as string);
        memberEmail =
          clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
          clerkUser.emailAddresses[0]?.emailAddress ??
          null;
        memberName  = memberName ?? ([clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || memberEmail);
      } catch { /* best-effort */ }
    }

    if (!memberEmail) {
      return res.status(422).json({ error: 'Could not resolve your email address. Please contact support directly.' });
    }

    const { subject, description, priority } = parsed.data;

    const response = await fetch(`${deskNinjaUrl}/api/v1/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        subject,
        body:          description,
        priority,
        customerEmail: memberEmail,
        customerName:  memberName ?? undefined,
        tags:          ['ninja-planner'],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // H5: Normalize desk-ninja 5xx to 502 — don't leak internal topology to clients.
      // L28: 401/403 from desk-ninja mean OUR service API key is bad/revoked — that's an upstream
      // configuration failure, not the end user's auth problem (a forwarded 401 would also make
      // the client think its own session expired), so it's a 502 too.
      // L25: upstream error text is logged, never forwarded.
      const upstreamText = await Promise.resolve()
        .then(() => response.text())
        .catch(() => '');
      logger.warn({ status: response.status, body: upstreamText.slice(0, 500) }, 'desk-ninja ticket creation failed');
      const upstreamAuthFailure = response.status === 401 || response.status === 403;
      const forwardStatus = response.status >= 500 || upstreamAuthFailure ? 502 : response.status;
      return res.status(forwardStatus).json({
        error: forwardStatus === 502 ? 'Support service error. Please try again.' : upstreamClientError(forwardStatus),
      });
    }

    // L25: a 2xx with a non-JSON / unexpected body is an upstream fault, not a 500 from us.
    const ticket = await response.json().catch(() => null) as { ticketNumber?: unknown; portalUrl?: unknown } | null;
    if (!ticket || typeof ticket.ticketNumber !== 'string') {
      logger.warn('desk-ninja returned an unexpected ticket response');
      return res.status(502).json({ error: 'Support service error. Please try again.' });
    }
    res.status(201).json({
      ticketNumber: ticket.ticketNumber,
      portalUrl: typeof ticket.portalUrl === 'string' ? ticket.portalUrl : null,
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      return res.status(502).json({ error: 'Support service timed out. Please try again.' });
    }
    next(err);
  }
});

export default router;
