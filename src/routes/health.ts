import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'ninja-planner',
    version: process.env.npm_package_version ?? '1.0.0',
  });
});

export default router;
