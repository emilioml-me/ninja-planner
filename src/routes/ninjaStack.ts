import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin }    from '../middleware/requireAdmin.js';
import { pool }            from '../config/db.js';
import { requirePlatformAdmin } from '../config/platformAdmins.js';
import { getSubscriptionStatus, activateSubscription } from '../services/subscriptionService.js';

const router = Router();

// Plan slugs as issued by ninja-core (e.g. 'starter', 'pro'). Validated as a short slug rather
// than a hard-coded enum so new ninja-core plans don't need a deploy here.
const planSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, 'Invalid plan');

// GET /api/ninja-stack/status
router.get('/status', requireWorkspace, async (req, res, next) => {
  try {
    const status = await getSubscriptionStatus(req.workspace.id);
    res.json(status);
  } catch (err) { next(err); }
});

// POST /api/ninja-stack/activate  [admin only]
router.post('/activate', requireWorkspace, requireAdmin, async (req, res, next) => {
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

// ─── Platform-admin override routes ───────────────────────────────────────────
// M13: these take an explicit target workspace id and do NOT run requireWorkspace - an operator
// must be able to grant/revoke an override on any workspace without joining it as a member
// (joining = full data access). requirePlatformAdmin is the only gate. Audit rows record the
// target workspace (admin_override_audit.workspace_id) and the acting operator.

const workspaceIdSchema = z.string().uuid();

/** Resolves :workspaceId to an existing workspace id, or sends 400/404 and returns null. */
async function resolveTargetWorkspace(req: Request, res: Response): Promise<string | null> {
  const parsed = workspaceIdSchema.safeParse(req.params.workspaceId);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid workspace id' }); return null; }
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [parsed.data]);
  if (rows.length === 0) { res.status(404).json({ error: 'Workspace not found' }); return null; }
  return rows[0].id;
}

// POST /api/ninja-stack/workspaces/:workspaceId/override  (platform admin only — grant free access)
// C6: previously gated by requireAdmin, i.e. any WORKSPACE admin could grant their own workspace
// a free paid plan. Now restricted to ninja-stack operators listed in PLATFORM_ADMIN_USER_IDS.
router.post('/workspaces/:workspaceId/override', requirePlatformAdmin, async (req, res, next) => {
  const parsed = z.object({ plan: planSchema.default('pro') }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
  const { plan } = parsed.data;

  let client: PoolClient | undefined;
  try {
    const workspaceId = await resolveTargetWorkspace(req, res);
    if (!workspaceId) return;
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
      [workspaceId, plan, req.auth.userId],
    );
    // Same transaction: an override must never exist without its audit row.
    await client.query(
      `INSERT INTO admin_override_audit (workspace_id, action, plan, actor_clerk_id)
       VALUES ($1, 'granted', $2, $3)`,
      [workspaceId, plan, req.auth.userId],
    );
    await client.query('COMMIT');
    res.json({ ok: true, workspace_id: workspaceId, plan });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// DELETE /api/ninja-stack/workspaces/:workspaceId/override  (platform admin only — revoke a free-access override)
router.delete('/workspaces/:workspaceId/override', requirePlatformAdmin, async (req, res, next) => {
  let client: PoolClient | undefined;
  try {
    const workspaceId = await resolveTargetWorkspace(req, res);
    if (!workspaceId) return;
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
      [workspaceId],
    );
    if (target.rows.length === 0) {
      await client.query('COMMIT');
      res.json({ ok: true, workspace_id: workspaceId });
      return;
    }

    const result = target.rows[0].code === 'admin-override'
      ? await client.query(
          'DELETE FROM ninja_stack_subscriptions WHERE workspace_id = $1 AND admin_override = TRUE',
          [workspaceId],
        )
      : await client.query(
          `UPDATE ninja_stack_subscriptions
           SET admin_override = FALSE, overridden_by = NULL, last_verified_at = to_timestamp(0)
           WHERE workspace_id = $1 AND admin_override = TRUE`,
          [workspaceId],
        );
    if ((result.rowCount ?? 0) > 0) {
      await client.query(
        `INSERT INTO admin_override_audit (workspace_id, action, actor_clerk_id)
         VALUES ($1, 'revoked', $2)`,
        [workspaceId, req.auth.userId],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, workspace_id: workspaceId });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// GET /api/ninja-stack/workspaces/:workspaceId/override/audit  (platform admin only)
router.get('/workspaces/:workspaceId/override/audit', requirePlatformAdmin, async (req, res, next) => {
  try {
    const workspaceId = await resolveTargetWorkspace(req, res);
    if (!workspaceId) return;
    // Operators usually aren't members of the target workspace, so display_name is best-effort
    // (any workspace where the operator has a cached profile).
    const { rows } = await pool.query(
      `SELECT a.workspace_id, a.action, a.plan, a.actor_clerk_id, a.created_at,
              (SELECT wm.display_name FROM workspace_members wm
                WHERE wm.clerk_user_id = a.actor_clerk_id AND wm.display_name IS NOT NULL
                ORDER BY (wm.workspace_id = a.workspace_id) DESC LIMIT 1) AS display_name
       FROM admin_override_audit a
       WHERE a.workspace_id = $1
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [workspaceId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
