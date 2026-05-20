import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();

// Tight rate limit specifically for the public invite-lookup endpoint — prevents brute-force
// token scanning (10 requests per minute per IP).
const inviteLookupLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// ─── Admin-protected: create invite ──────────────────────────────────────────

// POST /api/workspaces/me/invites  — generate (or return existing active) invite token
router.post('/me/invites', requireAuth, requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    // Revoke any existing unexpired invites for this workspace first (one active at a time)
    await pool.query(
      `UPDATE workspace_invites
         SET used_at = now(), used_by = 'revoked'
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [req.workspace.id],
    );

    const result = await pool.query<{ token: string; expires_at: string }>(
      `INSERT INTO workspace_invites (workspace_id, created_by)
       VALUES ($1, $2)
       RETURNING token, expires_at`,
      [req.workspace.id, req.auth.userId],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/workspaces/me/invites/active  — current active invite (if any)
router.get('/me/invites/active', requireAuth, requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query<{ token: string; expires_at: string }>(
      `SELECT token, expires_at
       FROM workspace_invites
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.workspace.id],
    );
    res.json(result.rows[0] ?? null);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/workspaces/me/invites  — revoke all active invites
router.delete('/me/invites', requireAuth, requireWorkspace, requireAdmin, async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE workspace_invites
         SET used_at = now(), used_by = 'revoked'
       WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()`,
      [req.workspace.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Public: look up invite ───────────────────────────────────────────────────

// GET /api/invites/token/:token  — validate token, return workspace name (no auth needed)
// Rate-limited to 10/min per IP to prevent brute-force token enumeration.
// Using /token/ prefix to avoid shadowing workspace routes when mounted at /api/workspaces.
router.get('/token/:token', inviteLookupLimiter, async (req, res, next) => {
  try {
    const result = await pool.query<{ workspace_name: string; expires_at: string }>(
      `SELECT w.name AS workspace_name, wi.expires_at
       FROM workspace_invites wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1 AND wi.used_at IS NULL AND wi.expires_at > now()`,
      [req.params.token],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Invite not found or expired' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/invites/token/:token/accept  — authenticated user accepts invite
// The ENTIRE flow (lock → member check → insert → mark used) runs in one transaction
// so FOR UPDATE actually prevents concurrent double-accepts.
router.post('/token/:token/accept', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the invite row — blocks concurrent accepts for the same token
    const inviteResult = await client.query<{
      id: string;
      workspace_id: string;
      clerk_org_id: string;
    }>(
      `SELECT wi.id, wi.workspace_id, w.clerk_org_id
       FROM workspace_invites wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1 AND wi.used_at IS NULL AND wi.expires_at > now()
       FOR UPDATE`,
      [req.params.token],
    );
    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Invite not found or expired' });
      return;
    }

    const { id: inviteId, workspace_id, clerk_org_id } = inviteResult.rows[0];

    // Check if already a member (within the transaction)
    const existing = await client.query(
      `SELECT id FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2`,
      [workspace_id, req.auth.userId],
    );
    if (existing.rows.length > 0) {
      // Already a member — mark invite used and return success
      await client.query(
        `UPDATE workspace_invites SET used_at = now(), used_by = $1 WHERE id = $2`,
        [req.auth.userId, inviteId],
      );
      await client.query('COMMIT');
      res.json({ ok: true, workspace_id, clerk_org_id, already_member: true });
      return;
    }

    // Add to workspace_members + mark invite used atomically
    await client.query(
      `INSERT INTO workspace_members (workspace_id, clerk_user_id, role)
       VALUES ($1, $2, 'org:member')
       ON CONFLICT (workspace_id, clerk_user_id) DO NOTHING`,
      [workspace_id, req.auth.userId],
    );
    await client.query(
      `UPDATE workspace_invites SET used_at = now(), used_by = $1 WHERE id = $2`,
      [req.auth.userId, inviteId],
    );
    await client.query('COMMIT');

    res.json({ ok: true, workspace_id, clerk_org_id, already_member: false });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
