import { Router } from 'express';
import { Webhook } from 'svix';
import { logger } from '../config/logger.js';
import { clerkClient } from '../config/clerk.js';
import {
  upsertWorkspaceFromClerk,
  upsertMemberFromClerk,
  deleteMemberFromClerk,
  revokeWorkspaceMembershipsForOrg,
} from '../services/workspaceService.js';

const router = Router();

/**
 * H14: svix does not guarantee delivery order and retries failed deliveries, so a stale
 * organizationMembership.created/updated can land AFTER a .deleted (re-adding a removed member)
 * or vice versa. Rather than trusting the event payload, reconcile against Clerk's CURRENT state
 * for that (org, user) pair: returns the live membership role, or null if none exists now.
 * Throws on Clerk API failure so the webhook returns 500 and svix retries.
 */
async function currentClerkMembershipRole(clerkOrgId: string, clerkUserId: string): Promise<string | null> {
  const list = await clerkClient.organizations.getOrganizationMembershipList({
    organizationId: clerkOrgId,
    userId: [clerkUserId],
    limit: 1,
  });
  const m = list.data.find((x) => x.publicUserData?.userId === clerkUserId);
  return m ? m.role : null;
}

router.post('/clerk', async (req, res) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('CLERK_WEBHOOK_SECRET not set');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  const svixId        = req.headers['svix-id'] as string;
  const svixTimestamp = req.headers['svix-timestamp'] as string;
  const svixSignature = req.headers['svix-signature'] as string;

  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: 'Missing svix headers' });
    return;
  }

  let event: { type: string; data: Record<string, unknown> };
  try {
    const wh = new Webhook(secret);
    event = wh.verify(req.body as Buffer, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as typeof event;
  } catch {
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  try {
    switch (event.type) {
      case 'organization.created':
      case 'organization.updated': {
        const d = event.data as { id: string; name: string };
        await upsertWorkspaceFromClerk({ clerkOrgId: d.id, name: d.name });
        break;
      }

      case 'organizationMembership.created':
      case 'organizationMembership.updated': {
        const d = event.data as {
          organization: { id: string };
          public_user_data: {
            user_id: string;
            first_name: string | null;
            last_name: string | null;
            identifier: string | null;   // email in most cases
            image_url: string | null;
          };
          role: string;
        };
        const pud = d.public_user_data;
        const liveRole = await currentClerkMembershipRole(d.organization.id, pud.user_id);
        if (liveRole === null) {
          // Membership was removed after this event was emitted — don't resurrect it.
          logger.info({ type: event.type, clerkOrgId: d.organization.id, clerkUserId: pud.user_id }, 'Skipping stale membership event (no longer a member in Clerk)');
          break;
        }
        const display_name =
          [pud.first_name, pud.last_name].filter(Boolean).join(' ') || pud.identifier || null;
        await upsertMemberFromClerk({
          clerkOrgId:   d.organization.id,
          clerkUserId:  pud.user_id,
          role:         liveRole,
          display_name,
          email:        pud.identifier ?? null,
          avatar_url:   pud.image_url  ?? null,
        });
        break;
      }

      case 'organizationMembership.deleted': {
        const d = event.data as {
          organization: { id: string };
          public_user_data: { user_id: string };
        };
        if (await currentClerkMembershipRole(d.organization.id, d.public_user_data.user_id) !== null) {
          // User was re-added after this delete was emitted — keep the membership.
          logger.info({ type: event.type, clerkOrgId: d.organization.id }, 'Skipping stale membership delete (member again in Clerk)');
          break;
        }
        await deleteMemberFromClerk({
          clerkOrgId: d.organization.id,
          clerkUserId: d.public_user_data.user_id,
        });
        break;
      }

      case 'organization.deleted': {
        const d = event.data as { id?: string };
        if (d.id) {
          const removed = await revokeWorkspaceMembershipsForOrg(d.id);
          logger.info({ clerkOrgId: d.id, removed }, 'Organization deleted - revoked all workspace memberships');
        }
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled webhook event');
    }

    res.status(200).json({ received: true });
  } catch (err) {
    logger.error({ err, type: event.type }, 'Webhook handler error');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
