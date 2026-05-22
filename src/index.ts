import dotenv from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const REQUIRED_ENV = ['CLERK_SECRET_KEY', 'CLERK_WEBHOOK_SECRET', 'DATABASE_URL'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
  console.error('Missing required env var: ALLOWED_ORIGIN');
  process.exit(1);
}

import { logger }     from './config/logger.js';
import { createApp }  from './app.js';

const app  = createApp();
const PORT = parseInt(process.env.PORT ?? '3206', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'ninja-planner started');
});
