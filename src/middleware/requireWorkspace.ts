import type { Request, Response, NextFunction } from 'express';
import { pool } from '../config/db.js';

export async function requireWorkspace(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { userId, orgId } = req.auth;

  if (!orgId) {
    res.status(403).json({ error: 'No active organization in token' });
    return;
  }

  try {
    const wsResult = await pool.query<{ id: string; name: string; plan: string }>(
      'SELECT id, name, plan FROM workspaces WHERE clerk_org_id = $1',
      [orgId],
    );

    if (wsResult.rows.length === 0) {
      res.status(403).json({ error: 'Workspace not found' });
      return;
    }

    const workspace = wsResult.rows[0];

    const memberResult = await pool.query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND clerk_user_id = $2',
      [workspace.id, userId],
    );

    if (memberResult.rows.length === 0) {
      res.status(403).json({ error: 'Not a member of this workspace' });
      return;
    }

    req.auth.memberRole = memberResult.rows[0].role;
    req.workspace = workspace;
    next();
  } catch (err) {
    next(err);
  }
}
