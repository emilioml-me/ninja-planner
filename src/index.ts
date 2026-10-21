// MUST stay the first import: loads .env and validates required vars before any other module
// (db.ts, r2.ts, services) reads process.env at load time. See config/env.ts (M35).
import './config/env.js';

import { logger }     from './config/logger.js';
import { pool }       from './config/db.js';
import { createApp }  from './app.js';
import { drainBackground } from './lib/background.js';
import { startDueDateScheduler, stopDueDateScheduler } from './services/automationService.js';
import { startRetentionScheduler, stopRetentionScheduler } from './services/retentionService.js';

// Keep a stray rejection from killing the process silently (Node's default is to crash) - log it
// with context instead. Uncaught exceptions leave the process in an unknown state: log and exit
// so Docker restarts it.
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception - exiting');
  process.exit(1);
});

const app  = createApp();
const PORT = parseInt(process.env.PORT ?? '3206', 10);
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT, env: process.env.NODE_ENV }, 'ninja-planner started');
  try {
    startDueDateScheduler();
  } catch (err) {
    logger.error({ err }, 'due-date scheduler failed to start');
  }
  try {
    startRetentionScheduler();
  } catch (err) {
    logger.error({ err }, 'retention scheduler failed to start');
  }
});

// M40: graceful shutdown. Docker sends SIGTERM (entrypoint.sh execs node as PID 1): stop taking
// new work, let in-flight requests and tracked background work (webhooks, automations, emails)
// finish, then close the pool. Hard deadline so a stuck request can't block the stop forever
// (compose stop_grace_period must exceed it, or Docker SIGKILLs at its 10s default).
const BACKGROUND_DRAIN_MS = 20_000;
const HARD_EXIT_MS = 25_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');

  const hardExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out - forcing exit');
    process.exit(1);
  }, HARD_EXIT_MS);
  hardExit.unref();

  stopDueDateScheduler();
  stopRetentionScheduler();

  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err) logger.warn({ err }, 'server.close reported an error');
      resolve();
    });
    // Keep-alive sockets would otherwise hold close() open until they time out.
    server.closeIdleConnections();
  });

  await drainBackground(BACKGROUND_DRAIN_MS);

  try {
    await pool.end();
  } catch (err) {
    logger.warn({ err }, 'pool.end failed');
  }
  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
