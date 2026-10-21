import { Router } from 'express';
import { Webhook } from 'svix';
import { logger } from '../config/logger.js';
import { clerkClient } from '../config/clerk.js';
import {
  upsertWorkspaceFromClerk,
  upsertMemberFromClerk,
  deleteMemberFromClerk,
  deactivateWorkspaceForOrg,
  updateMemberProfileFromClerk,
  WorkspaceNotFoundError,
} from '../services/workspaceService.js';

const router = Router();

const ORG_MISSING = Symbol('org_missing');

function isClerkNotFound(err: unknown): boolean {
  const e = err as { status?: number; errors?: Array<{ code?: string }> } | null;
  if (e?.status === 404) return true;
  return Array.isArray(e?.errors) && e!.errors!.some((x) => x?.code === 'resource_not_found');
}

/**
 * H14: svix does not guarantee delivery order and retries failed deliveries, so a stale
 * organizationMembership.created/updated can land AFTER a .deleted (re-adding a removed member)
 * or vice versa. Rather than trusting the event payload, reconcile against Clerk's CURRENT state
 * for that (org, user) pair: returns the live membership role, null if none exists now, or
 * ORG_MISSING when the organization itself no longer exists in Clerk (L19: events arriving after
 * org deletion are a no-op, not a 500 that svix retries until it gives up).
 * Throws on any other Clerk API failure so the webhook returns 500 and svix retries.
 */
async function currentClerkMembershipRole(
  clerkOrgId: string,
  clerkUserId: string,
): Promise<string | null | typeof ORG_MISSING> {
  try {
    const list = await clerkClient.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId,
      userId: [clerkUserId],
      limit: 1,
    });
    const m = list.data.find((x) => x.publicUserData?.userId === clerkUserId);
    return m ? m.role : null;
  } catch (err) {
    if (isClerkNotFound(err)) return ORG_MISSING;
    throw err;
  }
}

function looksLikeEmail(v: string | null | undefined): string | null {
  return v && v.includes('@') ? v : null;
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
        if (liveRole === ORG_MISSING) {
          logger.info({ type: event.type, clerkOrgId: d.organization.id }, 'Skipping membership event for an organization that no longer exists');
          break;
        }
        if (liveRole === null) {
          // Membership was removed after this event was emitted — don't resurrect it.
          logger.info({ type: event.type, clerkOrgId: d.organization.id, clerkUserId: pud.user_id }, 'Skipping stale membership event (no longer a member in Clerk)');
          break;
        }
        const display_name =
          [pud.first_name, pud.last_name].filter(Boolean).join(' ') || pud.identifier || null;
        const member = {
          clerkOrgId:   d.organization.id,
          clerkUserId:  pud.user_id,
          role:         liveRole,
          display_name,
          email:        looksLikeEmail(pud.identifier),
          avatar_url:   pud.image_url  ?? null,
        };
        try {
          await upsertMemberFromClerk(member);
        } catch (err) {
          if (!(err instanceof WorkspaceNotFoundError)) throw err;
          // organization.created hasn't landed yet but the org demonstrably exists in Clerk
          // (the membership lookup above succeeded) - create the workspace row from Clerk's
          // current state and retry once instead of failing the delivery.
          const org = await clerkClient.organizations.getOrganization({ organizationId: d.organization.id });
          await upsertWorkspaceFromClerk({ clerkOrgId: org.id, name: org.name });
          await upsertMemberFromClerk(member);
        }
        break;
      }

      case 'organizationMembership.deleted': {
        const d = event.data as {
          organization: { id: string };
          public_user_data: { user_id: string };
        };
        const liveRole = await currentClerkMembershipRole(d.organization.id, d.public_user_data.user_id);
        if (liveRole !== null && liveRole !== ORG_MISSING) {
          // User was re-added after this delete was emitted — keep the membership.
          logger.info({ type: event.type, clerkOrgId: d.organization.id }, 'Skipping stale membership delete (member again in Clerk)');
          break;
        }
        // Also fine when the org is gone: a no-op delete (organization.deleted already cleared it).
        await deleteMemberFromClerk({
          clerkOrgId: d.organization.id,
          clerkUserId: d.public_user_data.user_id,
        });
        break;
      }

      case 'organization.deleted': {
        const d = event.data as { id?: string };
        if (d.id) {
          const counts = await deactivateWorkspaceForOrg(d.id);
          logger.info({ clerkOrgId: d.id, ...counts }, 'Organization deleted - workspace access revoked');
        }
        break;
      }

      case 'user.updated': {
        // L18: keep the cached profile columns (members list, emails, notifications) current.
        const d = event.data as {
          id: string;
          first_name: string | null;
          last_name: string | null;
          image_url: string | null;
          primary_email_address_id: string | null;
          email_addresses?: Array<{ id: string; email_address: string }>;
        };
        const emails = Array.isArray(d.email_addresses) ? d.email_addresses : [];
        const email =
          emails.find((e) => e.id === d.primary_email_address_id)?.email_address ??
          emails[0]?.email_address ??
          null;
        const display_name = [d.first_name, d.last_name].filter(Boolean).join(' ') || email || null;
        const updated = await updateMemberProfileFromClerk({
          clerkUserId: d.id,
          display_name,
          email,
          avatar_url: d.image_url ?? null,
        });
        logger.debug({ clerkUserId: d.id, updated }, 'Refreshed member profile from user.updated');
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
