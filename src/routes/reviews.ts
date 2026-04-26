import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getReviews,
  createReview,
  getReviewById,
  updateReview,
} from '../services/reviewService.js';

const router = Router();
router.use(requireWorkspace);

const createSchema = z.object({
  week_start:    z.string().date(),
  wins:          z.string().optional(),
  blockers:      z.string().optional(),
  focus_next:    z.string().optional(),
  health_score:  z.number().int().min(1).max(5).optional(),
});

const updateSchema = createSchema.omit({ week_start: true }).partial();

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
    res.status(201).json(review);
  } catch (err) {
    // Unique constraint violation (duplicate week_start for workspace)
    if ((err as { code?: string }).code === '23505') {
      res.status(409).json({ error: 'A review for this week already exists' });
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

// PATCH /api/reviews/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const review = await updateReview(req.params.id, req.workspace.id, parsed.data);
    if (!review) {
      res.status(404).json({ error: 'Review not found' });
      return;
    }
    res.json(review);
  } catch (err) {
    next(err);
  }
});

export default router;
