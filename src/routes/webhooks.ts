import { Router } from 'express';
import { Webhook } from 'svix';
import { logger } from '../config/logger.js';
import {
  upsertWorkspaceFromClerk,
  upsertMemberFromClerk,
  deleteMemberFromClerk,
} from '../services/workspaceService.js';

const router = Router();

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

      case 'organizationMembership.created': {
        const d = event.data as {
          organization: { id: string };
          public_user_data: { user_id: string };
          role: string;
        };
        await upsertMemberFromClerk({
          clerkOrgId: d.organization.id,
          clerkUserId: d.public_user_data.user_id,
          role: d.role,
        });
        break;
      }

      case 'organizationMembership.deleted': {
        const d = event.data as {
          organization: { id: string };
          public_user_data: { user_id: string };
        };
        await deleteMemberFromClerk({
          clerkOrgId: d.organization.id,
          clerkUserId: d.public_user_data.user_id,
        });
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
