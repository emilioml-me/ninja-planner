import { Router } from 'express';
import { getPublicRoadmap } from '../services/shareService.js';

/**
 * Public routes — no auth required.
 * Mounted at /public in index.ts (before requireAuth middleware).
 */
const router = Router();

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

export default router;
