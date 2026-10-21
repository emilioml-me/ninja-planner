/**
 * migrate.ts — run SQL migrations in order, idempotently.
 *
 * Reads every *.sql file from /app/migrations (or ../migrations relative
 * to this script) in alphabetical order, records applied migrations in a
 * `schema_migrations` table, and skips already-applied ones.
 *
 * Each file runs inside its own transaction together with its
 * schema_migrations insert. Some older files (034-049) carry their own
 * `BEGIN;` ... `COMMIT;` wrapper, which would commit the runner's outer
 * transaction early (so a failure after the inner COMMIT left the schema
 * changed but the file unrecorded). Those already-applied files must not be
 * edited, so the runner strips a leading BEGIN; / trailing COMMIT; pair
 * before executing (see stripOuterTransaction).
 *
 * Concurrency: DATABASE_URL goes through PgBouncer in transaction pooling mode, so a
 * session-level pg_advisory_lock/unlock pair could land on different backends (leaking the
 * lock and hanging the next deploy). Instead every file's transaction first takes
 * pg_advisory_xact_lock (released automatically at COMMIT/ROLLBACK on the same backend) and
 * re-checks schema_migrations inside that transaction, so two containers starting at once
 * (e.g. a rolling deploy) can't apply the same file twice.
 *
 * Timeouts (SET LOCAL, so they never leak to other pooled clients):
 *  - MIGRATE_LOCK_WAIT_TIMEOUT (default 120s): how long to wait for another runner's lock;
 *  - MIGRATE_LOCK_TIMEOUT (default 30s): per-DDL wait for table locks held by the live app;
 *  - MIGRATE_STATEMENT_TIMEOUT (default 15min): per-statement cap.
 *
 * A file whose first line is `-- migrate:no-transaction` (needed for CREATE INDEX
 * CONCURRENTLY) runs statement by statement outside a transaction and is recorded afterwards.
 * Such files must be idempotent (IF NOT EXISTS) and may only contain plain statements each
 * ending with `;` at end of line (no $$ bodies), since they are split on that.
 *
 * Usage: node dist/migrate.js
 * Exits 0 on success, 1 on error.
 */

import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

import { readdir, readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import pkg from 'pg';
import type { PoolClient } from 'pg';

const { Pool } = pkg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 10_000,
});

// Resolve migrations directory:
//  In production: this script is at /app/dist/scripts/migrate.js → migrations at /app/migrations
//  In dev (ts-node):              src/scripts/migrate.ts           → migrations at ./migrations
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'migrations');

// Arbitrary app-specific key for pg_advisory_xact_lock (must fit in a signed bigint).
const MIGRATION_LOCK_KEY = 7_206_320_601;

// Postgres duration strings (e.g. '30s', '15min'); validated so a typo can't inject SQL.
const DURATION_RE = /^\d+\s*(?:ms|s|min|h)?$/;
function durationEnv(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  if (!DURATION_RE.test(v)) {
    console.warn(`[migrate] ignoring invalid ${name}=${v}; using ${fallback}`);
    return fallback;
  }
  return v;
}
const LOCK_WAIT_TIMEOUT = durationEnv('MIGRATE_LOCK_WAIT_TIMEOUT', '120s');
const LOCK_TIMEOUT = durationEnv('MIGRATE_LOCK_TIMEOUT', '30s');
const STATEMENT_TIMEOUT = durationEnv('MIGRATE_STATEMENT_TIMEOUT', '15min');

const NO_TRANSACTION_RE = /^\s*--\s*migrate:no-transaction\s*$/im;

type Client = PoolClient;

/**
 * Opens a transaction holding the migration advisory lock, with the configured timeouts.
 * The lock wait itself is bounded by LOCK_WAIT_TIMEOUT so a stuck runner fails the deploy
 * loudly instead of hanging entrypoint.sh forever.
 */
async function beginLocked(client: Client): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT_TIMEOUT}'`);
  await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
  await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
}

async function isApplied(client: Client, file: string): Promise<boolean> {
  const { rows } = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
  return rows.length > 0;
}

/** Splits a no-transaction file into statements on `;` at end of line (comments dropped). */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of sql.split('\n')) {
    if (IGNORABLE_LINE_RE.test(line)) continue;
    current.push(line);
    if (/;\s*$/.test(line)) {
      out.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) out.push(current.join('\n'));
  return out;
}

// Whole-line transaction-control statements, e.g. `BEGIN;`, `BEGIN TRANSACTION;`, `COMMIT;`.
const BEGIN_LINE_RE = /^\s*(?:BEGIN(?:\s+(?:TRANSACTION|WORK))?|START\s+TRANSACTION)\s*;\s*$/i;
const COMMIT_LINE_RE = /^\s*COMMIT(?:\s+(?:TRANSACTION|WORK))?\s*;\s*$/i;
const IGNORABLE_LINE_RE = /^\s*(?:--.*)?$/; // blank or comment-only

/**
 * Removes a self-managed transaction wrapper from a migration file so it runs inside the
 * runner's own transaction. The first statement line must be a bare BEGIN; and the last a
 * bare COMMIT; (blank/comment lines around them are ignored); only when BOTH are present is
 * anything stripped. A plpgsql `BEGIN`/`END;` inside a function body never matches because it
 * is neither the first nor the last statement line (and has no `;` after BEGIN).
 */
function stripOuterTransaction(sql: string): string {
  const lines = sql.split('\n');
  let first = 0;
  while (first < lines.length && IGNORABLE_LINE_RE.test(lines[first])) first++;
  let last = lines.length - 1;
  while (last >= 0 && IGNORABLE_LINE_RE.test(lines[last])) last--;
  if (first >= last) return sql;
  if (!BEGIN_LINE_RE.test(lines[first]) || !COMMIT_LINE_RE.test(lines[last])) return sql;
  lines[first] = '';
  lines[last] = '';
  return lines.join('\n');
}

async function run() {
  const client = await pool.connect();
  try {
    // Ensure tracking table exists (under the lock: two concurrent CREATE TABLE IF NOT EXISTS
    // can still collide on the catalog).
    await beginLocked(client);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name       text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    // List + sort migration files
    let files: string[];
    try {
      const entries = await readdir(MIGRATIONS_DIR);
      files = entries.filter((f) => f.endsWith('.sql')).sort();
    } catch (err) {
      console.error('[migrate] Cannot read migrations directory: ' + MIGRATIONS_DIR, err);
      process.exitCode = 1;
      return;
    }

    if (files.length === 0) {
      console.log('[migrate] No migration files found — nothing to do');
      return;
    }

    // Fast pre-check (no lock) so already-applied files are skipped without a transaction each;
    // every file still re-checks under the lock before running.
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.name));

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] skip  ${file}`);
        continue;
      }

      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

      if (NO_TRANSACTION_RE.test(raw.split('\n')[0] ?? '')) {
        // Statements like CREATE INDEX CONCURRENTLY can't run in a transaction (nor in a
        // multi-statement simple query), so each runs on its own; the file must be idempotent
        // because a concurrent runner may execute it too. Recorded under the lock afterwards.
        try {
          for (const stmt of splitStatements(raw)) {
            await client.query(stmt);
          }
          await beginLocked(client);
          await client.query(
            'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
            [file],
          );
          await client.query('COMMIT');
          console.log(`[migrate] apply ${file} (no transaction)`);
          ran++;
          continue;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.error('[migrate] FAILED ' + file, err);
          process.exitCode = 1;
          return;
        }
      }

      const sql = stripOuterTransaction(raw);
      if (sql !== raw) {
        console.log(`[migrate] note  ${file}: stripped its own BEGIN/COMMIT (runner wraps it)`);
      }

      try {
        await beginLocked(client);
        // Another runner may have applied it while we waited for the lock.
        if (await isApplied(client, file)) {
          await client.query('COMMIT');
          console.log(`[migrate] skip  ${file} (applied concurrently)`);
          continue;
        }
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
        console.log(`[migrate] apply ${file}`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[migrate] FAILED ' + file, err);
        process.exitCode = 1;
        return;
      }
    }

    if (ran === 0) {
      console.log('[migrate] Database is up to date');
    } else {
      console.log(`[migrate] Applied ${ran} migration(s) successfully`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[migrate] Unexpected error', err);
  process.exit(1);
});
