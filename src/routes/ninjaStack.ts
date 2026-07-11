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
    // ON CONFLICT deliberately leaves `code`/`allowed_apps` untouched when a real subscription
    // already exists for this workspace — that's what lets DELETE /override (below) revoke the
    // override and fall back to revalidating the real underlying code, instead of losing it.
    // GET /status already surfaces the effective plan/code while admin_override is active, so
    // this doesn't leave anything user-facing "stale" — only a direct DB inspection would see
    // the real code sitting under an active override, which is intentional, not a bug.
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
    await pool.query(
      `INSERT INTO admin_override_audit (workspace_id, action, plan, actor_clerk_id)
       VALUES ($1, 'granted', $2, $3)`,
      [req.workspace.id, plan, req.auth.userId],
    );
    res.json({ ok: true, plan });
  } catch (err) { next(err); }
});

// DELETE /api/ninja-stack/override  (admin only — revoke a free-access override)
router.delete('/override', requireAdmin, async (req, res, next) => {
  try {
    // Just flipping admin_override to FALSE wasn't enough: getSubscriptionStatus() only
    // re-evaluates a non-override row once it's "stale" (expired or >24h since
    // last_verified_at) — neither is true right after a grant — so the workspace kept looking
    // active for up to 24h after an explicit revoke.
    //
    // POST /override's ON CONFLICT UPDATE never touches `code`/`allowed_apps`, so a workspace
    // that had a real subscription before the override keeps its real code sitting underneath;
    // deleting the row unconditionally would destroy that. Instead: if the row's code is still
    // the synthetic 'admin-override' placeholder (no real subscription underneath — this is the
    // common case), delete it outright so status flips to inactive immediately. Otherwise, force
    // immediate revalidation against the real underlying code by resetting last_verified_at.
    const target = await pool.query<{ code: string }>(
      'SELECT code FROM ninja_stack_subscriptions WHERE workspace_id = $1 AND admin_override = TRUE',
      [req.workspace.id],
    );
    if (target.rows.length === 0) { res.json({ ok: true }); return; }

    const result = target.rows[0].code === 'admin-override'
      ? await pool.query(
          'DELETE FROM ninja_stack_subscriptions WHERE workspace_id = $1 AND admin_override = TRUE',
          [req.workspace.id],
        )
      : await pool.query(
          `UPDATE ninja_stack_subscriptions
           SET admin_override = FALSE, overridden_by = NULL, last_verified_at = to_timestamp(0)
           WHERE workspace_id = $1 AND admin_override = TRUE`,
          [req.workspace.id],
        );
    if ((result.rowCount ?? 0) > 0) {
      await pool.query(
        `INSERT INTO admin_override_audit (workspace_id, action, actor_clerk_id)
         VALUES ($1, 'revoked', $2)`,
        [req.workspace.id, req.auth.userId],
      );
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/ninja-stack/override/audit  (admin only)
router.get('/override/audit', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.action, a.plan, a.actor_clerk_id, a.created_at, wm.display_name
       FROM admin_override_audit a
       LEFT JOIN workspace_members wm ON wm.clerk_user_id = a.actor_clerk_id AND wm.workspace_id = a.workspace_id
       WHERE a.workspace_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
