import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { deleteObject, isR2Configured } from '../lib/r2.js';

/** Presigned-but-unconfirmed uploads older than this are treated as abandoned. */
const PENDING_MAX_AGE_HOURS = 24;
/** Rows handled per sweep (the scheduler runs hourly, so a backlog drains over a few runs). */
const SWEEP_BATCH = 500;

/**
 * Delete R2 objects (and their pending_uploads rows) for uploads that were presigned but never
 * confirmed within 24h. Objects referenced by a task_attachments row are never deleted (the
 * confirm succeeded but clearing the pending row failed) - only the row is dropped.
 *
 * Rows are claimed with DELETE ... FOR UPDATE SKIP LOCKED so concurrent sweeps (several app
 * instances) never process the same key; a key whose object delete fails is re-inserted with its
 * original created_at so the next sweep retries it.
 */
export async function sweepPendingUploads(): Promise<{ deleted: number; failed: number }> {
  if (!isR2Configured()) return { deleted: 0, failed: 0 };

  const claimed = await pool.query<{
    r2_key: string; workspace_id: string; task_id: string | null; created_by: string | null; created_at: Date;
  }>(
    `DELETE FROM pending_uploads
     WHERE r2_key IN (
       SELECT r2_key FROM pending_uploads
       WHERE created_at < now() - make_interval(hours => $1)
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING r2_key, workspace_id, task_id, created_by, created_at`,
    [PENDING_MAX_AGE_HOURS, SWEEP_BATCH],
  );
  if (claimed.rows.length === 0) return { deleted: 0, failed: 0 };

  const keys = claimed.rows.map((r) => r.r2_key);
  const referenced = await pool.query<{ r2_key: string }>(
    'SELECT r2_key FROM task_attachments WHERE r2_key = ANY($1)',
    [keys],
  );
  const keep = new Set(referenced.rows.map((r) => r.r2_key));

  let deleted = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    if (keep.has(row.r2_key)) continue;
    try {
      await deleteObject(row.r2_key);
      deleted++;
    } catch (err) {
      failed++;
      logger.warn({ err, r2_key: row.r2_key }, 'pending upload sweep: R2 delete failed, will retry');
      await pool.query(
        `INSERT INTO pending_uploads (r2_key, workspace_id, task_id, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (r2_key) DO NOTHING`,
        [row.r2_key, row.workspace_id, row.task_id, row.created_by, row.created_at],
      ).catch((insErr) => {
        logger.error({ err: insErr, r2_key: row.r2_key }, 'pending upload sweep: could not requeue key - manual cleanup required');
      });
    }
  }

  if (deleted > 0 || failed > 0) {
    logger.info({ deleted, failed, kept: keep.size }, 'pending upload sweep complete');
  }
  return { deleted, failed };
}
