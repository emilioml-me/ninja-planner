import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin }    from '../middleware/requireAdmin.js';
import { pool }            from '../config/db.js';
import { getSubscriptionStatus, activateSubscription } from '../services/subscriptionService.js';

const router = Router();
router.use(requireWorkspace);

// GET /api/ninja-stack/status
router.get('/status', async (req, res, next) => {
  try {
    const status = await getSubscriptionStatus(req.workspace.id);
    res.json(status);
  } catch (err) { next(err); }
});

// POST /api/ninja-stack/activate  [admin only]
router.post('/activate', requireAdmin, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.body);
    const status = await activateSubscription(req.workspace.id, code);
    res.json(status);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Code is required' });
    const msg = err.message;
    if (msg === 'ninja_core_unreachable') return res.status(502).json({ error: 'Could not reach ninja-core. Try again later.' });
    if (msg === 'app_not_allowed')        return res.status(403).json({ error: 'This subscription code does not include plan-ninja.' });
    if (msg === 'invalid_code')           return res.status(400).json({ error: 'Invalid or expired subscription code.' });
    next(err);
  }
});

// POST /api/ninja-stack/override  (admin only — grant free access)
router.post('/override', requireAdmin, async (req, res, next) => {
  try {
    const { plan } = z.object({ plan: z.string().default('pro') }).parse(req.body);
    await pool.query(
      `INSERT INTO ninja_stack_subscriptions
         (workspace_id, code, plan, allowed_apps, admin_override, overridden_by, activated_at, last_verified_at)
       VALUES ($1,'admin-override',$2,'{"plan-ninja"}',TRUE,$3,NOW(),NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         admin_override = TRUE,
         overridden_by = EXCLUDED.overridden_by,
         last_verified_at = NOW()`,
      [req.workspace.id, plan, req.auth.userId],
    );
    res.json({ ok: true, plan });
  } catch (err) { next(err); }
});

export default router;
