// app.ts — Express app factory (separated from server startup for testability)
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import express            from 'express';
import helmet             from 'helmet';
import cors               from 'cors';
import rateLimit          from 'express-rate-limit';
import pinoHttp           from 'pino-http';

import { logger }      from './config/logger.js';
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
import { workspaceInvitesRouter, publicInvitesRouter } from './routes/invites.js';
import keyResultsRouter       from './routes/keyResults.js';
import taskTemplatesRouter    from './routes/taskTemplates.js';
import epicsRouter            from './routes/epics.js';
import taskDepsRouter         from './routes/taskDependencies.js';
import timeLogsRouter         from './routes/timeLogs.js';
import taskWatchersRouter     from './routes/taskWatchers.js';
import attachmentsRouter      from './routes/attachments.js';
import budgetsRouter          from './routes/budgets.js';
import changelogRouter        from './routes/changelog.js';
import aiSummaryRouter        from './routes/aiSummary.js';
import timelineRouter         from './routes/timeline.js';
import supportRouter          from './routes/support.js';
import ninjaStackRouter       from './routes/ninjaStack.js';
import docsRouter             from './routes/docs.js';
import analyticsRouter        from './routes/analytics.js';
import meetingNotesRouter     from './routes/meetingNotes.js';
import sprintTemplatesRouter  from './routes/sprintTemplates.js';
import projectSharesRouter    from './routes/projectShares.js';
import guestViewRouter        from './routes/guestView.js';
import apiKeysRouter          from './routes/apiKeys.js';
import customFieldsRouter     from './routes/customFields.js';
import automationsRouter      from './routes/automations.js';
import csvImportRouter        from './routes/csvImport.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);

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
        scriptSrc:      [
          "'self'",
          ...(process.env.NODE_ENV !== 'production' ? ["'unsafe-inline'"] : []),
          ...(clerkOrigin ? [clerkOrigin] : []),
          'https://static.cloudflareinsights.com',
        ],
        scriptSrcAttr: ["'none'"],
        workerSrc:     ["'self'", 'blob:'],
        connectSrc:    ["'self'", ...(clerkOrigin ? [clerkOrigin] : []), 'https://api.clerk.com', 'https://cloudflareinsights.com'],
        styleSrc:      ["'self'", 'https:', "'unsafe-inline'"],
        upgradeInsecureRequests: [],
      },
    },
  }));

  // M2: Fall back to false (block all cross-origin) rather than undefined (allow all)
  // when ALLOWED_ORIGIN is not set — prevents wide-open CORS in misconfigured deploys.
  app.use(cors({ origin: process.env.ALLOWED_ORIGIN ?? false, credentials: true }));

  app.use(rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false }));

  // Skip HTTP logging in test
  if (process.env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger }));
  }

  app.use('/health', healthRouter);
  app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);
  app.use(express.json());
  app.use('/public', shareRouter);
  app.use('/public/g', guestViewRouter);

  app.use('/api', requireAuth);

  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/workspaces', membersRouter);
  app.use('/api/tasks/import',   csvImportRouter);  // must be before tasksRouter to avoid /:id capture
  app.use('/api/tasks',                          tasksRouter);
  app.use('/api/tasks/:taskId/comments',         commentsRouter);
  app.use('/api/revenue',        revenueRouter);
  app.use('/api/roadmap',        roadmapRouter);
  app.use('/api/reviews',        reviewsRouter);
  app.use('/api/notifications',  notificationsRouter);
  app.use('/api/integrations',   integrationsRouter);
  app.use('/api/goals',          goalsRouter);
  app.use('/api/goals/:goalId/key-results',       keyResultsRouter);
  app.use('/api/task-templates',                  taskTemplatesRouter);
  app.use('/api/sprints',        sprintsRouter);
  app.use('/api/webhooks',       webhookEndpointsRouter);
  app.use('/api/workspaces',     workspaceInvitesRouter);  // H1: admin invite management
  app.use('/api/invites',        publicInvitesRouter);     // H1: public token lookup + accept
  app.use('/api/epics',          epicsRouter);
  app.use('/api/tasks/:taskId/dependencies',      taskDepsRouter);
  app.use('/api/tasks/:taskId/time-logs',         timeLogsRouter);
  app.use('/api/tasks/:taskId/watchers',          taskWatchersRouter);
  app.use('/api/tasks/:taskId/attachments',       attachmentsRouter);
  app.use('/api/budgets',        budgetsRouter);
  app.use('/api/changelog',      changelogRouter);
  app.use('/api/timeline',       timelineRouter);
  app.use('/api/sprints/:sprintId/ai-summary',    aiSummaryRouter);
  app.use('/api/support',        supportRouter);
  app.use('/api/ninja-stack',    ninjaStackRouter);
  app.use('/api/analytics',      analyticsRouter);
  app.use('/api/meeting-notes',  meetingNotesRouter);
  app.use('/api/sprint-templates', sprintTemplatesRouter);
  app.use('/api/project-shares', projectSharesRouter);
  app.use('/api/api-keys',       apiKeysRouter);
  app.use('/api/custom-fields',  customFieldsRouter);
  app.use('/api/automations',    automationsRouter);
  // M3: API docs only in non-production — avoids exposing the full OpenAPI schema publicly
  if (process.env.NODE_ENV !== 'production') {
    app.use('/api/docs', docsRouter);
  }

  if (process.env.NODE_ENV === 'production') {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const publicDir = join(__dirname, 'public');
    app.use(express.static(publicDir));
    // M8: Return JSON 404 for unmatched /api/* routes instead of serving index.html
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
    app.get('*', (_req, res) => { res.sendFile(join(publicDir, 'index.html')); });
  }

  app.use(errorHandler);
  return app;
}
