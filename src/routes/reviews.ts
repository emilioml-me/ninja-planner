import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getReviews,
  createReview,
  getReviewById,
  updateReview,
  deleteReview,
} from '../services/reviewService.js';

const REVIEW_ADMIN_ROLES = new Set(['org:admin', 'org:owner']);
import { sendSlackMessage } from '../lib/slack.js';
import { fireWebhooks } from '../services/webhookService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

// Weekly reviews are keyed by the Monday that starts the week.
const weekStartSchema = z.string().date().refine(
  (v) => new Date(`${v}T00:00:00Z`).getUTCDay() === 1,
  { message: 'week_start must be a Monday' },
);

const createSchema = z.object({
  week_start:    weekStartSchema,
  wins:          z.string().max(10000).optional(),
  blockers:      z.string().max(10000).optional(),
  focus_next:    z.string().max(10000).optional(),
  health_score:  z.number().int().min(1).max(5).optional(),
});

// Text fields and health_score accept null so they can be cleared; week_start is editable
// (still must be a Monday; moving onto a week the author already reviewed -> 409).
const updateSchema = z.object({
  week_start:    weekStartSchema.optional(),
  wins:          z.string().max(10000).nullable().optional(),
  blockers:      z.string().max(10000).nullable().optional(),
  focus_next:    z.string().max(10000).nullable().optional(),
  health_score:  z.number().int().min(1).max(5).nullable().optional(),
});

// GET /api/reviews
router.get('/', async (req, res, next) => {
  try {
    const reviews = await getReviews(req.workspace.id);
    res.json(reviews);
  } catch (err) {
    next(err);
  }
});

// POST /api/reviews
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const review = await createReview(req.workspace.id, parsed.data, req.auth.userId);

    // Slack notification — fire-and-forget
    const score = review.health_score ? ` · Health ${review.health_score}/5` : '';
    sendSlackMessage(
      `:clipboard: *Weekly review submitted* for week of ${review.week_start}${score}\n` +
      (review.wins     ? `*Wins:* ${review.wins.slice(0, 200)}\n`     : '') +
      (review.blockers ? `*Blockers:* ${review.blockers.slice(0, 200)}` : ''),
      req.workspace.id,
    );

    fireWebhooks(req.workspace.id, 'review.submitted', { review });

    // In-app notification for admins — the migration comment reserving 'review_submitted'
    // as a notification type dates back to day one, but it was only ever wired up as a
    // Slack message + webhook, never an actual in-app notification.
    pool.query<{ clerk_user_id: string }>(
      `SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 AND role IN ('org:admin', 'org:owner')`,
      [req.workspace.id],
    ).then((adminResult) => {
      for (const { clerk_user_id } of adminResult.rows) {
        if (clerk_user_id === req.auth.userId) continue;
        createNotification({
          workspaceId: req.workspace.id,
          recipientClerkId: clerk_user_id,
          type: 'review_submitted',
          title: `Weekly review submitted for week of ${review.week_start}`,
          link: '/reviews',
        }).catch(() => {});
      }
    }).catch(() => {});

    res.status(201).json(review);
  } catch (err) {
    // Unique constraint violation — reviews are per member: UNIQUE (workspace_id, week_start,
    // created_by) since migration 052, so this means the caller already reviewed this week.
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'You already submitted a review for this week. Edit it instead.' });
      return;
    }
    next(err);
  }
});

// GET /api/reviews/:id
router.get('/:id', async (req, res, next) => {
  try {
    const review = await getReviewById(req.params.id, req.workspace.id);
    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    res.json(review);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/reviews/:id  — creator or admin only
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    // Ownership check: only the creator or an admin can update a review
    const existing = await getReviewById(req.params.id, req.workspace.id);
    if (!existing) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    const isAdmin = req.auth.memberRole ? REVIEW_ADMIN_ROLES.has(req.auth.memberRole) : false;
    if (existing.created_by !== req.auth.userId && !isAdmin) {
      res.status(403).json({ error: 'Only the creator or an admin can edit this review' });
      return;
    }
    const review = await updateReview(req.params.id, req.workspace.id, parsed.data);
    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    res.json(review);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'The author already has a review for that week' });
      return;
    }
    next(err);
  }
});

// DELETE /api/reviews/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteReview(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
