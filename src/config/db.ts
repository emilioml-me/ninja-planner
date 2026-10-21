import pkg from 'pg';
import { logger } from './logger.js';

const { Pool, types } = pkg;

// Without this, pg parses `date` columns (e.g. tasks.due_date) into JS Date objects. Every
// route/service in this codebase treats due_date as a plain 'YYYY-MM-DD' string (Zod schemas,
// string equality checks like tasks.ts's dueDateActuallyChanged, template-string interpolation
// into notification/email text) — a Date object compared with `!==` against that string is
// never equal, and template-interpolated it renders as `Date.prototype.toString()` output
// ("Tue Aug 25 2026 00:00:00 GMT+0000...") instead of the date. Keeping the raw string from the
// wire (OID 1082 = date) makes every `SELECT`/`RETURNING` of a date column behave the way the
// rest of the app already assumes, without needing an explicit ::text cast at every call site.
types.setTypeParser(1082, (val: string) => val);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// L37: bound every query. A server-side `statement_timeout` can't be passed as a connection
// startup parameter here - PgBouncer (transaction pooling on ninja-db001) rejects unknown startup
// parameters - so this is node-pg's client-side query_timeout: the promise rejects and pool.query
// destroys the client instead of waiting forever. For a server-side cap as well, set it on the DB
// role (ALTER ROLE <app_user> SET statement_timeout = '30s'); long-running jobs use SET LOCAL.
function queryTimeoutMs(): number {
  const raw = Number(process.env.DB_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  query_timeout: queryTimeoutMs(),
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool idle client error');
});
