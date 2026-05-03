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

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { logger } from './config/logger.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

import healthRouter     from './routes/health.js';
import webhooksRouter   from './routes/webhooks.js';
import workspacesRouter from './routes/workspaces.js';
import membersRouter    from './routes/members.js';
import tasksRouter        from './routes/tasks.js';
import commentsRouter     from './routes/comments.js';
import revenueRouter      from './routes/revenue.js';
import roadmapRouter      from './routes/roadmap.js';
import reviewsRouter      from './routes/reviews.js';
import notificationsRouter from './routes/notifications.js';
import integrationsRouter from './routes/integrations.js';
import goalsRouter        from './routes/goals.js';
import sprintsRouter      from './routes/sprints.js';
import shareRouter        from './routes/share.js';
import webhookEndpointsRouter from './routes/webhook-endpoints.js';

const app = express();

// Trust HAProxy → Nginx proxy chain
app.set('trust proxy', 1);

// Security headers — allow Clerk proxy domain (derived from ALLOWED_ORIGIN)
const clerkOrigin = process.env.ALLOWED_ORIGIN
  ? `https://clerk.${new URL(process.env.ALLOWED_ORIGIN).host}`
  : '';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      baseUri:        ["'self'"],
      fontSrc:        ["'self'", 'https:', 'data:'],
      formAction:     ["'self'"],
      frameAncestors: ["'self'"],
      frameSrc:       ["'self'", ...(clerkOrigin ? [clerkOrigin] : [])],
      imgSrc:         ["'self'", 'data:', 'https:'],
      objectSrc:      ["'none'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", ...(clerkOrigin ? [clerkOrigin] : []), 'https://static.cloudflareinsights.com'],
      scriptSrcAttr:  ["'none'"],
      // Clerk creates a blob: worker for JWT polling — worker-src must allow it
      // (without this directive, browsers fall back to script-src which lacks blob:)
      workerSrc:      ["'self'", "blob:"],
      connectSrc:     ["'self'", ...(clerkOrigin ? [clerkOrigin] : []), 'https://api.clerk.com', 'https://cloudflareinsights.com'],
      styleSrc:       ["'self'", 'https:', "'unsafe-inline'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// CORS locked to configured origin
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN,
  credentials: true,
}));

// Rate limiting — 200 req/min per IP
app.use(rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Request logging
app.use(pinoHttp({ logger }));

// ─── Health (no auth, no body parsing needed) ────────────────────────────────
app.use('/health', healthRouter);

// ─── Webhooks (raw body required for svix signature verification) ────────────
app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

// ─── JSON body parsing for all API routes ────────────────────────────────────
app.use(express.json());

// ─── Public routes (no auth) ─────────────────────────────────────────────────
app.use('/public', shareRouter);

// ─── Protected API routes ────────────────────────────────────────────────────
app.use('/api', requireAuth);

app.use('/api/workspaces', workspacesRouter);
app.use('/api/workspaces', membersRouter);
app.use('/api/tasks',                       tasksRouter);
app.use('/api/tasks/:taskId/comments',      commentsRouter);  // mergeParams passes :taskId
app.use('/api/revenue',       revenueRouter);
app.use('/api/roadmap',       roadmapRouter);
app.use('/api/reviews',       reviewsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/integrations',  integrationsRouter);
app.use('/api/goals',         goalsRouter);
app.use('/api/sprints',       sprintsRouter);
app.use('/api/webhooks',      webhookEndpointsRouter);

// ─── Static frontend (production) ────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(__dirname, 'public');
  app.use(express.static(publicDir));
  app.get('*', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

// ─── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler);

const PORT = parseInt(process.env.PORT ?? '3206', 10);
app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV }, 'ninja-planner started');
});
