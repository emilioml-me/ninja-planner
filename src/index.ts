// MUST stay the first import: loads .env and validates required vars before any other module
// (db.ts, r2.ts, services) reads process.env at load time. See config/env.ts (M35).
import './config/env.js';

import { logger }     from './config/logger.js';
import { createApp }  from './app.js';

const app  = createApp();
const PORT = parseInt(process.env.PORT ?? '3206', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'ninja-planner started');
  import('./services/automationService.js').then((m) => m.startDueDateScheduler()).catch((err) => logger.error({ err }, 'due-date scheduler failed to start'));
});
