/**
 * migrate.ts — run SQL migrations in order, idempotently.
 *
 * Reads every *.sql file from /app/migrations (or ../migrations relative
 * to this script) in alphabetical order, records applied migrations in a
 * `schema_migrations` table, and skips already-applied ones.
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

async function run() {
  const client = await pool.connect();
  try {
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
      console.error(`[migrate] Cannot read migrations directory: ${MIGRATIONS_DIR}`, err);
      process.exit(1);
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

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

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
        await client.query('ROLLBACK');
        console.error(`[migrate] FAILED ${file}`, err);
        process.exit(1);
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
