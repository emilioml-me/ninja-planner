// H1: Split into two routers to avoid double-mounting the same router.
// workspaceInvitesRouter → mounted at /api/workspaces (admin routes)
// publicInvitesRouter    → mounted at /api/invites (public token routes)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import type { PoolClient } from 'pg';
import { pool } from '../config/db.js';
import { ensureClerkOrgMembership } from '../services/workspaceService.js';
import { getClientIp, ipBucket } from '../lib/clientIp.js';

// Tight rate limit for public invite-lookup — prevents brute-force token scanning
const inviteLookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipBucket(getClientIp(req)),
  message: { error: 'Too many requests, please try again later' },
});

// ─── Workspace-scoped admin routes (mounted at /api/workspaces) ───────────────

export const workspaceInvitesRouter = Router();

// POST /api/workspaces/me/invites
workspaceInvitesRouter.post('/me/invites', requireWorkspace, requireAdmin, async (req, res, next) => {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Serializes concurrent "revoke old, create new" calls for this workspace — without it, two
    // near-simultaneous requests (two admins, or a double-click) could each run the revoke UPDATE
    // before either INSERT commits, so both see "nothing to revoke yet" and both proceed,
    // leaving two simultaneously-valid, unrevoked invite tokens instead of the intended single
    // active invite. Released automatically on commit/rollback.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [req.workspace.id]);

    await client.query(
      `UPDATE workspace_invites
         SET used_at = now(), used_by = 'revoked'
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [req.workspace.id],
    );
    const result = await client.query<{ token: string; expires_at: string }>(
      `INSERT INTO workspace_invites (workspace_id, created_by)
       VALUES ($1, $2)
       RETURNING token, expires_at`,
      [req.workspace.id, req.auth.userId],
    );
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// GET /api/workspaces/me/invites/active
workspaceInvitesRouter.get('/me/invites/active', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query<{ token: string; expires_at: string }>(
      `SELECT token, expires_at
       FROM workspace_invites
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [req.workspace.id],
    );
    res.json(result.rows[0] ?? null);
  } catch (err) { next(err); }
});

// DELETE /api/workspaces/me/invites
workspaceInvitesRouter.delete('/me/invites', requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE workspace_invites
         SET used_at = now(), used_by = 'revoked'
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [req.workspace.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Public token routes (mounted at /api/invites) ────────────────────────────

export const publicInvitesRouter = Router();

// GET /api/invites/token/:token — validate token, return workspace name (no auth)
publicInvitesRouter.get('/token/:token', inviteLookupLimiter, async (req, res, next) => {
  try {
    const result = await pool.query<{ workspace_name: string; expires_at: string }>(
      `SELECT w.name AS workspace_name, wi.expires_at
       FROM workspace_invites wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1 AND wi.used_at IS NULL AND wi.expires_at > now()`,
      [req.params.token],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Invite not found or expired' }); return;
    }
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// POST /api/invites/token/:token/accept — authenticated user accepts invite
// publicInvitesRouter is mounted BEFORE the global requireAuth (so the lookup above stays
// public), so this route needs its own requireAuth.
publicInvitesRouter.post('/token/:token/accept', requireAuth, async (req, res, next) => {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const inviteResult = await client.query<{ id: string; workspace_id: string; clerk_org_id: string }>(
      `SELECT wi.id, wi.workspace_id, w.clerk_org_id
       FROM workspace_invites wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1 AND wi.used_at IS NULL AND wi.expires_at > now()
       FOR UPDATE OF wi`,
      [req.params.token],
    );
    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Invite not found or expired' }); return;
    }

    const { id: inviteId, workspace_id, clerk_org_id } = inviteResult.rows[0];

    const existing = await client.query(
      `SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2`,
      [workspace_id, req.auth.userId],
    );
    const alreadyMember = existing.rows.length > 0;
    let insertedMember = false;
    if (!alreadyMember) {
      // C2c: existing members don't consume the (single-use) invite — it stays valid for the
      // person it was actually meant for.
      const ins = await client.query(
        `INSERT INTO workspace_members (workspace_id, clerk_user_id, role)
         VALUES ($1, $2, 'org:member')
         ON CONFLICT (workspace_id, clerk_user_id) DO NOTHING`,
        [workspace_id, req.auth.userId],
      );
      insertedMember = (ins.rowCount ?? 0) > 0;
      await client.query(`UPDATE workspace_invites SET used_at = now(), used_by = $1 WHERE id = $2`, [req.auth.userId, inviteId]);
    }
    await client.query('COMMIT');
    client.release();
    client = undefined;

    // C2b: requireWorkspace resolves the workspace from the Clerk org claim in the session token,
    // so a local workspace_members row alone never grants access — the user must also be a
    // member of the Clerk organization. Idempotent: "already a member" is treated as success.
    // L20: done AFTER commit so the invite row lock isn't held across the Clerk round trip; on
    // failure the local effects are compensated (member row removed, invite un-consumed).
    try {
      await ensureClerkOrgMembership(clerk_org_id, req.auth.userId);
    } catch (clerkErr) {
      if (!alreadyMember) {
        await (async () => {
          if (insertedMember) {
            await pool.query(
              'DELETE FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
              [workspace_id, req.auth.userId],
            );
          }
          await pool.query(
            `UPDATE workspace_invites SET used_at = NULL, used_by = NULL
             WHERE id = $1 AND used_by = $2 AND expires_at > now()`,
            [inviteId, req.auth.userId],
          );
        })().catch(() => { /* best-effort; Clerk error below is what the caller needs */ });
      }
      throw clerkErr;
    }

    res.json({ ok: true, workspace_id, clerk_org_id, already_member: alreadyMember });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// Default export: combined router (kept for any existing direct imports)
const router = Router();
router.use(workspaceInvitesRouter);
router.use(publicInvitesRouter);
export default router;
