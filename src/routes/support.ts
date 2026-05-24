import { Router } from 'express';
import { z }      from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool }             from '../config/db.js';
import { clerkClient }      from '../config/clerk.js';

const router = Router();
router.use(requireWorkspace);

const ticketSchema = z.object({
  subject:     z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
});

// POST /api/support/ticket
// Proxies to desk-ninja /api/v1/tickets on behalf of the calling user.
router.post('/ticket', async (req, res, next) => {
  try {
    const parsed = ticketSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten().fieldErrors });
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
        memberEmail = clerkUser.emailAddresses[0]?.emailAddress ?? null;
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
      const err = await response.json().catch(() => ({})) as { error?: string };
      // H5: Normalize desk-ninja 5xx to 502 — don't leak internal topology to clients
      const forwardStatus = response.status >= 500 ? 502 : response.status;
      return res.status(forwardStatus).json({ error: forwardStatus === 502 ? 'Support service error. Please try again.' : (err.error ?? 'Failed to create support ticket.') });
    }

    const ticket = await response.json() as { ticketNumber: string; portalUrl: string };
    res.status(201).json({ ticketNumber: ticket.ticketNumber, portalUrl: ticket.portalUrl });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      return res.status(502).json({ error: 'Support service timed out. Please try again.' });
    }
    next(err);
  }
});

export default router;
