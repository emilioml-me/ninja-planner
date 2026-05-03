import { randomBytes } from 'crypto';
import { pool } from '../config/db.js';
import type { RoadmapItem } from './roadmapService.js';

export interface ShareToken {
  id: string;
  workspace_id: string;
  token: string;
  resource: string;
  created_by: string;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * Returns existing token for workspace/resource, or creates a new one.
 */
export async function upsertShareToken(
  workspaceId: string,
  resource: string,
  createdBy: string,
): Promise<ShareToken> {
  const token = randomBytes(32).toString('hex');
  const result = await pool.query<ShareToken>(
    `INSERT INTO share_tokens (workspace_id, token, resource, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, resource) DO UPDATE
       SET token = share_tokens.token  -- keep existing token, just return it
     RETURNING *`,
    [workspaceId, token, resource, createdBy],
  );
  return result.rows[0];
}

export async function getShareToken(workspaceId: string, resource: string): Promise<ShareToken | null> {
  const result = await pool.query<ShareToken>(
    'SELECT * FROM share_tokens WHERE workspace_id = $1 AND resource = $2',
    [workspaceId, resource],
  );
  return result.rows[0] ?? null;
}

export async function revokeShareToken(workspaceId: string, resource: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM share_tokens WHERE workspace_id = $1 AND resource = $2',
    [workspaceId, resource],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface PublicRoadmap {
  workspace: { name: string };
  items: RoadmapItem[];
}

export async function getPublicRoadmap(token: string): Promise<PublicRoadmap | null> {
  const tokenResult = await pool.query<{ workspace_id: string; resource: string; expires_at: Date | null }>(
    `SELECT workspace_id, resource, expires_at FROM share_tokens WHERE token = $1`,
    [token],
  );
  if (tokenResult.rows.length === 0) return null;

  const { workspace_id, resource, expires_at } = tokenResult.rows[0];
  if (resource !== 'roadmap') return null;
  if (expires_at && new Date() > expires_at) return null;

  const [wsResult, itemsResult] = await Promise.all([
    pool.query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [workspace_id]),
    pool.query<RoadmapItem>(
      `SELECT * FROM roadmap_items
       WHERE workspace_id = $1 AND status != 'archived'
       ORDER BY priority, created_at`,
      [workspace_id],
    ),
  ]);

  if (wsResult.rows.length === 0) return null;

  return {
    workspace: { name: wsResult.rows[0].name },
    items: itemsResult.rows,
  };
}
