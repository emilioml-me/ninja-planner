// Data retention (M35): periodically prunes append-only tables that otherwise grow forever.
//
//   webhook_deliveries  - full payload per endpoint per event; kept 30 days (delivery log UI)
//   automation_logs     - kept 90 days (by ran_at)
//   notifications       - READ notifications older than 90 days (unread are never deleted;
//                         dedup-marker rows - dedup_key / goal_milestone - are kept so a pruned
//                         marker can't re-fire an old notification)
//   task_activity       - kept (audit history)
//
// Deletes run in small batches, each in its own transaction guarded by
// pg_try_advisory_xact_lock, so concurrent containers never double-run a batch and the lock is
// safe under PgBouncer transaction pooling. Also schedules the hourly pending-upload sweep (M39).
// Disabled entirely with RETENTION_DISABLED=true.
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { trackBackground } from '../lib/background.js';
import { sweepPendingUploads } from './attachmentCleanup.js';

const RETENTION_LOCK_KEY = 72_310_452; // arbitrary constant, unique to this job
const BATCH_SIZE = 2_000;
const MAX_BATCHES_PER_TABLE = 200;     // <= 400k rows per table per run; the rest goes next run
const DAILY_MS = 24 * 60 * 60 * 1000;
const HOURLY_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

interface RetentionRule {
  name: string;
  /** DELETE statement that removes at most $1 rows and returns their count via rowCount. */
  sql: string;
}

const RULES: RetentionRule[] = [
  {
    name: 'webhook_deliveries',
    sql: `DELETE FROM webhook_deliveries
          WHERE id IN (
            SELECT id FROM webhook_deliveries
            WHERE created_at < now() - interval '30 days'
            LIMIT $1
          )`,
  },
  {
    name: 'automation_logs',
    sql: `DELETE FROM automation_logs
          WHERE id IN (
            SELECT id FROM automation_logs
            WHERE ran_at < now() - interval '90 days'
            LIMIT $1
          )`,
  },
  {
    name: 'notifications',
    sql: `DELETE FROM notifications
          WHERE id IN (
            SELECT id FROM notifications
            WHERE read_at IS NOT NULL
              AND read_at < now() - interval '90 days'
              AND dedup_key IS NULL
              AND type <> 'goal_milestone'
            LIMIT $1
          )`,
  },
];

/**
 * Run one locked batch. Returns the deleted row count, or null if another instance holds the
 * lock (caller stops - that instance is doing the work).
 */
async function runBatch(rule: RetentionRule): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [RETENTION_LOCK_KEY],
    );
    if (!lock.rows[0]?.locked) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await client.query(rule.sql, [BATCH_SIZE]);
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

let stopping = false;

/** One retention pass over every rule. Returns rows deleted per table. */
export async function runRetention(): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of RULES) {
    let total = 0;
    try {
      for (let i = 0; i < MAX_BATCHES_PER_TABLE && !stopping; i++) {
        const n = await runBatch(rule);
        if (n === null) {
          logger.info({ table: rule.name }, 'Retention skipped: another instance holds the lock');
          return deleted;
        }
        total += n;
        if (n < BATCH_SIZE) break;
      }
    } catch (err) {
      logger.error({ err, table: rule.name }, 'Retention batch failed');
    }
    deleted[rule.name] = total;
  }
  logger.info({ deleted }, 'Retention pass complete');
  return deleted;
}

let retentionTimer: NodeJS.Timeout | null = null;
let retentionFirstRun: NodeJS.Timeout | null = null;
let uploadsTimer: NodeJS.Timeout | null = null;
let retentionRunning = false;
let uploadsRunning = false;

function tickRetention(): void {
  if (retentionRunning || stopping) return;
  retentionRunning = true;
  trackBackground(runRetention())
    .catch((err) => logger.error({ err }, 'Retention pass failed'))
    .finally(() => { retentionRunning = false; });
}

function tickUploads(): void {
  if (uploadsRunning || stopping) return;
  uploadsRunning = true;
  trackBackground(Promise.resolve().then(() => sweepPendingUploads()))
    .catch((err) => logger.error({ err }, 'Pending upload sweep failed'))
    .finally(() => { uploadsRunning = false; });
}

/** Start the daily retention job and the hourly pending-upload sweep. Idempotent. */
export function startRetentionScheduler(): void {
  if (process.env.RETENTION_DISABLED === 'true') {
    logger.info('Retention scheduler disabled (RETENTION_DISABLED=true)');
    return;
  }
  if (retentionTimer || uploadsTimer) return;
  stopping = false;
  // First pass shortly after boot (not immediately - keep startup and deploy health checks light).
  retentionFirstRun = setTimeout(tickRetention, FIRST_RUN_DELAY_MS);
  retentionTimer = setInterval(tickRetention, DAILY_MS);
  uploadsTimer = setInterval(tickUploads, HOURLY_MS);
  retentionFirstRun.unref();
  retentionTimer.unref();
  uploadsTimer.unref();
  logger.info('Retention scheduler started');
}

/** Stop timers; an in-flight pass finishes its current batch (tracked via lib/background). */
export function stopRetentionScheduler(): void {
  stopping = true;
  if (retentionFirstRun) clearTimeout(retentionFirstRun);
  if (retentionTimer) clearInterval(retentionTimer);
  if (uploadsTimer) clearInterval(uploadsTimer);
  retentionFirstRun = null;
  retentionTimer = null;
  uploadsTimer = null;
}
