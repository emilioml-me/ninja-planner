import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  getPublicRoadmap,
  validateShareToken,
  addRoadmapVote,
  removeRoadmapVote,
} from '../services/shareService.js';

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
  message: { error: 'Too many votes, please try again later' },
});

const voteBodySchema = z.object({
  visitor_id: z.string().min(1).max(128),
});

// GET /public/roadmap/:token
router.get('/roadmap/:token', async (req, res, next) => {
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
    const workspaceId = await validateShareToken(req.params.token, 'roadmap');
    if (!workspaceId) {
      res.status(404).json({ error: 'Roadmap not found or link expired' });
      return;
    }
    const voteCount = await addRoadmapVote(req.params.itemId, workspaceId, parsed.data.visitor_id);
    if (voteCount === null) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json({ vote_count: voteCount });
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
    const workspaceId = await validateShareToken(req.params.token, 'roadmap');
    if (!workspaceId) {
      res.status(404).json({ error: 'Roadmap not found or link expired' });
      return;
    }
    const voteCount = await removeRoadmapVote(req.params.itemId, workspaceId, parsed.data.visitor_id);
    if (voteCount === null) {
      res.status(404).json({ error: 'Item not found' });
      return;
    }
    res.json({ vote_count: voteCount });
  } catch (err) {
    next(err);
  }
});

export default router;
