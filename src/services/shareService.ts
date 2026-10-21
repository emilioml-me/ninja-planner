import { randomBytes } from 'crypto';
import { pool } from '../config/db.js';

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

/**
 * The only roadmap fields exposed on the public (unauthenticated) page. Internal columns
 * (workspace_id, external_ref, timestamps, ...) are never selected - add a column here only if
 * the public page actually renders it.
 */
export interface PublicRoadmapItem {
  id: string;
  title: string;
  description: string | null;
  phase: string | null;
  status: string;
  priority: number;
  vote_count: number;
}

export interface PublicRoadmap {
  workspace: { name: string };
  items: PublicRoadmapItem[];
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
    pool.query<Omit<PublicRoadmapItem, 'vote_count'> & { vote_count: string }>(
      `SELECT ri.id, ri.title, ri.description, ri.phase, ri.status, ri.priority,
              COALESCE(v.cnt, 0) AS vote_count
       FROM roadmap_items ri
       LEFT JOIN (
         SELECT roadmap_item_id, COUNT(*) AS cnt
         FROM roadmap_votes
         WHERE roadmap_item_id IN (SELECT id FROM roadmap_items WHERE workspace_id = $1)
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
    items: itemsResult.rows.map((r) => ({ ...r, vote_count: parseInt(r.vote_count, 10) })),
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

/**
 * Max votes per item from one network (IP). Votes are deduped per visitor_id; the IP is only an
 * abuse limiter, so an office/NAT sharing one IP can still cast several distinct votes.
 *
 * The (roadmap_item_id, ip_hash) partial unique index from migration 012 is kept as the
 * enforcement mechanism: each vote stores `<ipHash>:<slot>` with slot in [0, MAX_VOTES_PER_IP),
 * so the index caps one network at MAX_VOTES_PER_IP votes per item instead of exactly one.
 */
export const MAX_VOTES_PER_IP = 25;

export type VoteResult =
  | { status: 'not_found' }
  | { status: 'ip_limit'; vote_count: number }
  | { status: 'ok'; vote_count: number; changed: boolean };

async function countVotes(roadmapItemId: string): Promise<number> {
  const countResult = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*) AS cnt FROM roadmap_votes WHERE roadmap_item_id = $1',
    [roadmapItemId],
  );
  return parseInt(countResult.rows[0].cnt, 10);
}

/** Votes are only accepted on items shown on the public page (same workspace, not archived). */
async function isVotableItem(roadmapItemId: string, workspaceId: string): Promise<boolean> {
  const itemCheck = await pool.query(
    `SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2 AND status != 'archived'`,
    [roadmapItemId, workspaceId],
  );
  return itemCheck.rows.length > 0;
}

/**
 * Add a vote. Idempotent per visitor_id: `changed` is false when this visitor had already voted.
 * ipHash is the salted HMAC of the requester's IP (see share.ts).
 */
export async function addRoadmapVote(
  roadmapItemId: string,
  workspaceId: string,
  visitorId: string,
  ipHash: string,
): Promise<VoteResult> {
  if (!(await isVotableItem(roadmapItemId, workspaceId))) return { status: 'not_found' };

  // Two attempts: a concurrent vote from the same network can take the slot we picked.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await pool.query<{ visitor_id: string; ip_hash: string | null }>(
      `SELECT visitor_id, ip_hash FROM roadmap_votes
       WHERE roadmap_item_id = $1 AND (visitor_id = $2 OR ip_hash LIKE $3)`,
      [roadmapItemId, visitorId, `${ipHash}:%`],
    );
    if (existing.rows.some((r) => r.visitor_id === visitorId)) {
      return { status: 'ok', vote_count: await countVotes(roadmapItemId), changed: false };
    }
    const usedSlots = new Set(existing.rows.map((r) => r.ip_hash?.slice(ipHash.length + 1)));
    let slot = -1;
    for (let k = 0; k < MAX_VOTES_PER_IP; k++) {
      if (!usedSlots.has(String(k))) { slot = k; break; }
    }
    if (slot === -1) return { status: 'ip_limit', vote_count: await countVotes(roadmapItemId) };

    const inserted = await pool.query(
      `INSERT INTO roadmap_votes (roadmap_item_id, visitor_id, ip_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [roadmapItemId, visitorId, `${ipHash}:${slot}`],
    );
    if (inserted.rows.length > 0) {
      return { status: 'ok', vote_count: await countVotes(roadmapItemId), changed: true };
    }
  }
  // Still conflicting after a retry: either this visitor's vote landed concurrently, or the slot
  // race repeated. Report the current state without claiming a change.
  return { status: 'ok', vote_count: await countVotes(roadmapItemId), changed: false };
}

/**
 * Remove a vote. The row must match BOTH the visitor_id and the requester's network (current
 * salted ip hash, the pre-salt legacy unsalted hash, or a legacy row with no ip_hash), so a
 * leaked visitor_id alone can't be used from elsewhere to retract someone's vote.
 */
export async function removeRoadmapVote(
  roadmapItemId: string,
  workspaceId: string,
  visitorId: string,
  ipHash: string,
  legacyIpHash: string | null,
): Promise<VoteResult> {
  if (!(await isVotableItem(roadmapItemId, workspaceId))) return { status: 'not_found' };

  const result = await pool.query(
    `DELETE FROM roadmap_votes
     WHERE roadmap_item_id = $1
       AND visitor_id = $2
       AND (ip_hash IS NULL OR ip_hash LIKE $3 OR ip_hash = $4)`,
    [roadmapItemId, visitorId, `${ipHash}:%`, legacyIpHash],
  );

  return { status: 'ok', vote_count: await countVotes(roadmapItemId), changed: (result.rowCount ?? 0) > 0 };
}
