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
 * NOTE: the existing token is preserved (use regenerateShareToken to force a new one).
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

/**
 * Always generates a fresh token, invalidating any previous one.
 * Use this for the "regenerate link" admin action so the old share URL stops working.
 */
export async function regenerateShareToken(
  workspaceId: string,
  resource: string,
  createdBy: string,
): Promise<ShareToken> {
  const token = randomBytes(32).toString('hex');
  const result = await pool.query<ShareToken>(
    `INSERT INTO share_tokens (workspace_id, token, resource, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, resource) DO UPDATE
       SET token = EXCLUDED.token, created_by = EXCLUDED.created_by
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
  items: (RoadmapItem & { vote_count: number })[];
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
    pool.query<RoadmapItem & { vote_count: string }>(
      `SELECT ri.*, COALESCE(v.cnt, 0) AS vote_count
       FROM roadmap_items ri
       LEFT JOIN (
         SELECT roadmap_item_id, COUNT(*) AS cnt
         FROM roadmap_votes
         GROUP BY roadmap_item_id
       ) v ON ri.id = v.roadmap_item_id
       WHERE ri.workspace_id = $1 AND ri.status != 'archived'
       ORDER BY ri.priority, ri.created_at`,
      [workspace_id],
    ),
  ]);

  if (wsResult.rows.length === 0) return null;

  return {
    workspace: { name: wsResult.rows[0].name },
    items: itemsResult.rows.map((r) => ({ ...r, vote_count: parseInt(r.vote_count as unknown as string, 10) })),
  };
}

/** Validate a share token and return workspace_id, or null if invalid. */
export async function validateShareToken(token: string, resource: string): Promise<string | null> {
  const result = await pool.query<{ workspace_id: string; expires_at: Date | null }>(
    `SELECT workspace_id, expires_at FROM share_tokens WHERE token = $1 AND resource = $2`,
    [token, resource],
  );
  if (result.rows.length === 0) return null;
  const { workspace_id, expires_at } = result.rows[0];
  if (expires_at && new Date() > expires_at) return null;
  return workspace_id;
}

/** Add a vote; returns new vote_count. Idempotent (ON CONFLICT DO NOTHING).
 *  ipHash (SHA-256 of requester's IP) is stored for secondary dedup via the partial unique index.
 */
export async function addRoadmapVote(
  roadmapItemId: string,
  workspaceId: string,
  visitorId: string,
  ipHash?: string | null,
): Promise<number | null> {
  // Verify item belongs to workspace
  const itemCheck = await pool.query(
    'SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
    [roadmapItemId, workspaceId],
  );
  if (itemCheck.rows.length === 0) return null;

  // INSERT respects both unique constraints: (roadmap_item_id, visitor_id) and
  // the partial index (roadmap_item_id, ip_hash) WHERE ip_hash IS NOT NULL.
  await pool.query(
    `INSERT INTO roadmap_votes (roadmap_item_id, visitor_id, ip_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [roadmapItemId, visitorId, ipHash ?? null],
  );

  const countResult = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM roadmap_votes WHERE roadmap_item_id = $1',
    [roadmapItemId],
  );
  return parseInt(countResult.rows[0].cnt, 10);
}

/** Remove a vote; returns new vote_count. */
export async function removeRoadmapVote(
  roadmapItemId: string,
  workspaceId: string,
  visitorId: string,
  ipHash?: string | null,
): Promise<number | null> {
  const itemCheck = await pool.query(
    'SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
    [roadmapItemId, workspaceId],
  );
  if (itemCheck.rows.length === 0) return null;

  // Remove by visitor_id (canonical) OR by ip_hash so IP-based dupes are also cleaned up
  await pool.query(
    `DELETE FROM roadmap_votes
     WHERE roadmap_item_id = $1
       AND (visitor_id = $2 OR (ip_hash IS NOT NULL AND ip_hash = $3))`,
    [roadmapItemId, visitorId, ipHash ?? null],
  );

  const countResult = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM roadmap_votes WHERE roadmap_item_id = $1',
    [roadmapItemId],
  );
  return parseInt(countResult.rows[0].cnt, 10);
}
