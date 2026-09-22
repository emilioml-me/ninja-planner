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
 * The whole run holds a session-level pg_advisory_lock so two containers
 * starting at once (e.g. a rolling deploy) can't apply the same file twice.
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

// Arbitrary app-specific key for pg_advisory_lock (must fit in a signed bigint).
const MIGRATION_LOCK_KEY = 7_206_320_601;

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
  let locked = false;
  try {
    // Serialize concurrent migration runs (multiple containers booting at once). Blocks until
    // any other runner finishes; that runner's applied files are then skipped below.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    // Ensure tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

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

    // Fetch already-applied migrations
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
      const sql = stripOuterTransaction(raw);
      if (sql !== raw) {
        console.log(`[migrate] note  ${file}: stripped its own BEGIN/COMMIT (runner wraps it)`);
      }

      await client.query('BEGIN');
      try {
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
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('[migrate] Unexpected error', err);
  process.exit(1);
});
