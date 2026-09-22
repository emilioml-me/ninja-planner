import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin }    from '../middleware/requireAdmin.js';
import { pool }            from '../config/db.js';
import { requirePlatformAdmin } from '../config/platformAdmins.js';
import { getSubscriptionStatus, activateSubscription } from '../services/subscriptionService.js';

const router = Router();
router.use(requireWorkspace);

// Plan slugs as issued by ninja-core (e.g. 'starter', 'pro'). Validated as a short slug rather
// than a hard-coded enum so new ninja-core plans don't need a deploy here.
const planSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, 'Invalid plan');

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
    const { code } = z.object({ code: z.string().trim().min(1).max(200) }).parse(req.body);
    const status = await activateSubscription(req.workspace.id, code);
    res.json(status);
  } catch (err: any) {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'Code is required' });
    const msg = err.message;
    if (msg === 'ninja_core_unreachable') return res.status(502).json({ error: 'Could not reach ninja-core. Try again later.' });
    if (msg === 'app_not_allowed')        return res.status(403).json({ error: 'This subscription code does not include Ninja Planner.' });
    if (msg === 'code_in_use')            return res.status(409).json({ error: 'This subscription code is already active on another workspace.' });
    if (msg === 'invalid_code' || msg === 'not_found' || msg === 'expired' || msg === 'revoked') return res.status(400).json({ error: 'Invalid or expired subscription code.' });
    next(err);
  }
});

// POST /api/ninja-stack/override  (platform admin only — grant free access)
// C6: previously gated by requireAdmin, i.e. any WORKSPACE admin could grant their own workspace
// a free paid plan. Now restricted to ninja-stack operators listed in PLATFORM_ADMIN_USER_IDS.
router.post('/override', requirePlatformAdmin, async (req, res, next) => {
  const parsed = z.object({ plan: planSchema.default('pro') }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { plan } = parsed.data;

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // ON CONFLICT deliberately leaves `code`/`allowed_apps` untouched when a real subscription
    // already exists for this workspace — that's what lets DELETE /override (below) revoke the
    // override and fall back to revalidating the real underlying code, instead of losing it.
    await client.query(
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
    // Same transaction: an override must never exist without its audit row.
    await client.query(
      `INSERT INTO admin_override_audit (workspace_id, action, plan, actor_clerk_id)
       VALUES ($1, 'granted', $2, $3)`,
      [req.workspace.id, plan, req.auth.userId],
    );
    await client.query('COMMIT');
    res.json({ ok: true, plan });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// DELETE /api/ninja-stack/override  (platform admin only — revoke a free-access override)
router.delete('/override', requirePlatformAdmin, async (req, res, next) => {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
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
    const target = await client.query<{ code: string }>(
      'SELECT code FROM ninja_stack_subscriptions WHERE workspace_id = $1 AND admin_override = TRUE FOR UPDATE',
      [req.workspace.id],
    );
    if (target.rows.length === 0) {
      await client.query('COMMIT');
      res.json({ ok: true });
      return;
    }

    const result = target.rows[0].code === 'admin-override'
      ? await client.query(
          'DELETE FROM ninja_stack_subscriptions WHERE workspace_id = $1 AND admin_override = TRUE',
          [req.workspace.id],
        )
      : await client.query(
          `UPDATE ninja_stack_subscriptions
           SET admin_override = FALSE, overridden_by = NULL, last_verified_at = to_timestamp(0)
           WHERE workspace_id = $1 AND admin_override = TRUE`,
          [req.workspace.id],
        );
    if ((result.rowCount ?? 0) > 0) {
      await client.query(
        `INSERT INTO admin_override_audit (workspace_id, action, actor_clerk_id)
         VALUES ($1, 'revoked', $2)`,
        [req.workspace.id, req.auth.userId],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// GET /api/ninja-stack/override/audit  (platform admin only)
router.get('/override/audit', requirePlatformAdmin, async (req, res, next) => {
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
