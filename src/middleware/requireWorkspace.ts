import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';
import { syncMemberDisplayName } from '../services/workspaceService.js';

export async function requireWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { userId, orgId } = req.auth;

  if (!orgId || (orgId as string).trim() === '') {
    res.status(403).json({ error: 'No active organization in token' });
    return;
  }

  try {
    // Single JOIN replaces two sequential queries
    const result = await pool.query<{ id: string; name: string; plan: string; role: string; display_name: string | null }>(
      `SELECT w.id, w.name, w.plan, wm.role, wm.display_name
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE w.clerk_org_id = $1 AND wm.clerk_user_id = $2`,
      [orgId, userId],
    );

    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { role, display_name, ...workspace } = result.rows[0];
    req.auth.memberRole = role;
    req.workspace = workspace;

    // Viewer is a read-only role — block any mutating request centrally here rather than
    // re-checking it in every route, since requireWorkspace runs first on virtually every router.
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
    if (role === 'viewer' && !SAFE_METHODS.has(req.method)) {
      res.status(403).json({ error: 'Viewers have read-only access' });
      return;
    }

    // Lazily backfill display_name from Clerk the first time it is missing
    if (display_name === null) {
      syncMemberDisplayName(workspace.id, userId as string).catch(() => {});
    }

    next();
  } catch (err) {
    next(err);
  }
}
