import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspaceAllowViewerWrites } from '../middleware/requireWorkspace.js';
import {
  getNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
  getNotificationPreferences,
  setNotificationPreference,
  NOTIFICATION_TYPES,
} from '../services/notificationService.js';

const router = Router();
// Every route here only reads or writes the CALLER's own notifications/preferences, so viewers
// (read-only for workspace data) must still be able to mark read and mute types.
router.use(requireWorkspaceAllowViewerWrites);

const listQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

// GET /api/notifications/preferences
router.get('/preferences', async (req, res, next) => {
  try {
    const prefs = await getNotificationPreferences(req.workspace.id, req.auth.userId);
    res.json(prefs);
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/preferences/:type
router.put('/preferences/:type', async (req, res, next) => {
  try {
    if (!(NOTIFICATION_TYPES as readonly string[]).includes(req.params.type)) {
      res.status(400).json({ error: 'Unknown notification type' });
      return;
    }
    const schema = z.object({ enabled: z.boolean() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    await setNotificationPreference(req.workspace.id, req.auth.userId, req.params.type, parsed.data.enabled);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications  — list for current user (most recent first)
router.get('/', async (req, res, next) => {
  try {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ error: q.error.flatten() }); return; }
    const notifications = await getNotifications(req.workspace.id, req.auth.userId, q.data.limit, q.data.offset);
    res.json(notifications);
  } catch (err) {
    next(err);
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.workspace.id, req.auth.userId);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/read-all
router.patch('/read-all', async (req, res, next) => {
  try {
    await markAllRead(req.workspace.id, req.auth.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res, next) => {
  try {
    const ok = await markRead(req.params.id, req.auth.userId, req.workspace.id);
    if (!ok) {
      res.status(404).json({ error: 'Notification not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
