// API key management — workspace-scoped keys for external integrations
import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomBytes } from 'crypto';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const VALID_SCOPES = ['tasks:read', 'tasks:write', 'roadmap:read', 'goals:read', 'sprints:read'] as const;

// L10: cap on active (non-revoked) keys per workspace.
const MAX_ACTIVE_KEYS_PER_WORKSPACE = 25;

const createSchema = z.object({
  name:   z.string().min(1).max(100),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1).default(['tasks:read']),
});

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// GET /api/api-keys  [admin]
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, key_prefix, scopes, last_used_at, revoked_at, created_at
       FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/api-keys  [admin] — returns plaintext key once, never stored
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { name, scopes } = parsed.data;

    const rawKey   = `np_${randomBytes(32).toString('base64url')}`;
    const keyHash  = hashKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12);

    // Count + insert serialized per workspace (advisory xact lock) so concurrent creates can't
    // both pass the cap check.
    const client = await pool.connect();
    let created: Record<string, unknown> | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`api_keys:${req.workspace.id}`]);
      const { rows: countRows } = await client.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL',
        [req.workspace.id],
      );
      if ((countRows[0]?.n ?? 0) >= MAX_ACTIVE_KEYS_PER_WORKSPACE) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: `A workspace can have at most ${MAX_ACTIVE_KEYS_PER_WORKSPACE} active API keys. Revoke an unused key first.` });
        return;
      }
      const { rows } = await client.query(
        `INSERT INTO api_keys (workspace_id, name, key_hash, key_prefix, scopes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, name, key_prefix, scopes, created_at`,
        [req.workspace.id, name, keyHash, keyPrefix, scopes, req.auth.userId],
      );
      await client.query('COMMIT');
      created = rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Return the raw key in this response only — it cannot be recovered later
    res.status(201).json({ ...created, key: rawKey });
  } catch (err) { next(err); }
});

// DELETE /api/api-keys/:id  [admin] — revoke
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
      [req.params.id, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Not found or already revoked' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export { VALID_SCOPES, hashKey };
export default router;
