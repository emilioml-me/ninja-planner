import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
} from '../services/notificationService.js';

const router = Router();
router.use(requireWorkspace);

// GET /api/notifications  — list for current user (most recent first)
router.get('/', async (req, res, next) => {
  try {
    const notifications = await getNotifications(req.workspace.id, req.auth.userId);
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
    const ok = await markRead(req.params.id, req.auth.userId);
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
