import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';

export async function requireWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { userId, orgId } = req.auth;

  if (!orgId) {
    res.status(403).json({ error: 'No active organization in token' });
    return;
  }

  try {
    // Single JOIN replaces two sequential queries
    const result = await pool.query<{ id: string; name: string; plan: string; role: string }>(
      `SELECT w.id, w.name, w.plan, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE w.clerk_org_id = $1 AND wm.clerk_user_id = $2`,
      [orgId, userId],
    );

    if (result.rows.length === 0) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { role, ...workspace } = result.rows[0];
    req.auth.memberRole = role;
    req.workspace = workspace;
    next();
  } catch (err) {
    next(err);
  }
}
