import { Router } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pool } from '../config/db.js';

const router = Router();

// npm_package_version is only set when started via `npm run`; the container runs `node dist/...`
// directly, so read the version from package.json (copied to /app) once at startup.
function resolveVersion(): string {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const VERSION = resolveVersion();
const DB_CHECK_TIMEOUT_MS = 2_000;

async function dbReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pool.query('SELECT 1').then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), DB_CHECK_TIMEOUT_MS); }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

router.get('/', async (_req, res) => {
  const dbOk = await dbReachable();
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    app: 'ninja-planner',
    version: VERSION,
    db: dbOk ? 'ok' : 'error',
  });
});

export default router;
