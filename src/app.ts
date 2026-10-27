// app.ts — Express app factory (separated from server startup for testability)
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { readFileSync }   from 'fs';
import express            from 'express';
import helmet             from 'helmet';
import cors               from 'cors';
import rateLimit          from 'express-rate-limit';
import pinoHttp           from 'pino-http';

import { logger }      from './config/logger.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { getAllowedOrigins } from './config/origins.js';
import { getClientIp, ipBucket } from './lib/clientIp.js';
import { renderSpaShell } from './lib/seoMeta.js';
import { createNinjaTaskWebhookRouter } from './routes/ninjataskWebhook.js';
import { createCrmWebhookRouter } from './routes/crmWebhook.js';
import { pool } from './config/db.js';

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
import epicCommentsRouter     from './routes/epicComments.js';
import taskDepsRouter         from './routes/taskDependencies.js';
import timeLogsRouter         from './routes/timeLogs.js';
import taskWatchersRouter     from './routes/taskWatchers.js';
import attachmentsRouter      from './routes/attachments.js';
import budgetsRouter          from './routes/budgets.js';
import changelogRouter        from './routes/changelog.js';
import aiSummaryRouter        from './routes/aiSummary.js';
import epicAiSummaryRouter    from './routes/epicAiSummary.js';
import timelineRouter         from './routes/timeline.js';
import supportRouter          from './routes/support.js';
import ninjaStackRouter       from './routes/ninjaStack.js';
import docsRouter             from './routes/docs.js';
import analyticsRouter        from './routes/analytics.js';
import meetingNotesRouter     from './routes/meetingNotes.js';
import sprintTemplatesRouter  from './routes/sprintTemplates.js';
import epicTemplatesRouter    from './routes/epicTemplates.js';
import projectSharesRouter    from './routes/projectShares.js';
import guestViewRouter        from './routes/guestView.js';
import apiKeysRouter          from './routes/apiKeys.js';
import customFieldsRouter     from './routes/customFields.js';
import automationsRouter      from './routes/automations.js';
import csvImportRouter        from './routes/csvImport.js';
import externalRouter         from './routes/external.js';
import clientsRouter          from './routes/clients.js';

// Clerk Frontend API host, encoded in the publishable key: pk_(live|test)_<base64("host$")>.
// Production keys decode to clerk.<domain>; development keys to <slug>.clerk.accounts.dev.
function clerkFrontendApiOrigin(allowedOrigins: string[]): string {
  const pk = (process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || '').trim();
  const m = pk.match(/^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/);
  if (m) {
    try {
      const host = Buffer.from(m[1], 'base64').toString('utf8').replace(/\$$/, '');
      if (/^[a-z0-9.-]+$/i.test(host)) return `https://${host}`;
    } catch {
      /* fall through */
    }
  }
  return allowedOrigins.length > 0 ? `https://clerk.${new URL(allowedOrigins[0]).host}` : '';
}

/** Extra CSP origins (comma-separated https origins) for one-off integrations. */
function cspExtraOrigins(): string[] {
  const out: string[] = [];
  for (const part of (process.env.CSP_EXTRA_ORIGINS ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.protocol === 'https:') out.push(u.origin);
    } catch {
      /* ignore malformed entry */
    }
  }
  return out;
}

// Token-bearing paths (guest links, public roadmaps, invites) - the token is a credential, so it
// must not end up in request logs.
const TOKEN_PATH_RE = /^(\/public\/g\/|\/public\/roadmap\/|\/api\/invites\/token\/|\/invite\/|\/r\/|\/g\/)([^/?#]+)/;

function redactTokenPath(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.replace(TOKEN_PATH_RE, '$1[redacted]');
}

export function createApp() {
  const app = express();

  // C1: production chain is Cloudflare -> HAProxy -> nginx -> container, so a fixed hop count is
  // wrong. Trust every loopback/private hop instead: req.ip becomes the first public address
  // (Cloudflare edge or real client), and lib/clientIp.ts resolves CF-Connecting-IP from there.
  app.set('trust proxy', ['loopback', 'uniquelocal']);

  const allowedOrigins = getAllowedOrigins();
  const clerkOrigin = clerkFrontendApiOrigin(allowedOrigins);
  const clerkOrigins = clerkOrigin ? [clerkOrigin] : [];
  const extraOrigins = cspExtraOrigins();
  const cloudflareChallenges = 'https://challenges.cloudflare.com';

  // H4: attachments are uploaded straight from the browser to a presigned R2 URL. The AWS SDK
  // presigns virtual-hosted-style URLs (https://<bucket>.<account>.r2.cloudflarestorage.com)
  // unless forcePathStyle is set, so allow both the account endpoint and its bucket subdomains.
  const r2AccountId = (process.env.R2_ACCOUNT_ID ?? '').trim();
  const r2Origins = /^[a-z0-9]+$/i.test(r2AccountId)
    ? [
        `https://${r2AccountId}.r2.cloudflarestorage.com`,
        `https://*.${r2AccountId}.r2.cloudflarestorage.com`,
      ]
    : [];

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        baseUri:        ["'self'"],
        fontSrc:        ["'self'", 'https:', 'data:'],
        formAction:     ["'self'"],
        frameAncestors: ["'self'"],
        frameSrc:       ["'self'", ...clerkOrigins, cloudflareChallenges, ...extraOrigins],
        imgSrc:         ["'self'", 'data:', 'https:', ...clerkOrigins],
        objectSrc:      ["'none'"],
        scriptSrc:      [
          "'self'",
          ...(process.env.NODE_ENV !== 'production' ? ["'unsafe-inline'"] : []),
          ...clerkOrigins,
          cloudflareChallenges,
          'https://static.cloudflareinsights.com',
          ...extraOrigins,
        ],
        scriptSrcAttr: ["'none'"],
        workerSrc:     ["'self'", 'blob:', ...clerkOrigins],
        connectSrc:    [
          "'self'",
          ...clerkOrigins,
          'https://api.clerk.com',
          'https://clerk-telemetry.com',
          'https://cloudflareinsights.com',
          ...r2Origins,
          ...extraOrigins,
        ],
        styleSrc:      ["'self'", 'https:', "'unsafe-inline'"],
        upgradeInsecureRequests: [],
      },
    },
  }));

  // M2: Fall back to false (block all cross-origin) rather than undefined (allow all)
  // when ALLOWED_ORIGIN is not set — prevents wide-open CORS in misconfigured deploys.
  // allowedHeaders is left unset on purpose: cors reflects Access-Control-Request-Headers, so the
  // client's Authorization and X-Timezone (lib/tz.ts) headers are both accepted.
  app.use(cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    exposedHeaders: ['X-Total-Count'],
  }));

  // Static SPA assets are served before the global limiter so page loads (JS/CSS chunks, icons)
  // don't consume the per-client API budget. index.html fallback stays at the end.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
  if (process.env.NODE_ENV === 'production') {
    // index: false so "/" also goes through renderSpaShell instead of getting the raw index.html
    app.use(express.static(publicDir, { index: false }));
  }

  app.use(rateLimit({
    windowMs: 60_000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipBucket(getClientIp(req)),
  }));

  // Skip HTTP logging in test; redact Authorization to keep raw API keys out of logs, and token
  // path segments (guest/public roadmap/invite links) to keep those credentials out too.
  if (process.env.NODE_ENV !== 'test') {
    app.use(pinoHttp({
      logger,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req(req: { url?: string; params?: Record<string, unknown> }) {
          req.url = redactTokenPath(req.url);
          if (req.params && typeof req.params === 'object' && 'token' in req.params) {
            req.params = { ...req.params, token: '[redacted]' };
          }
          return req;
        },
      },
    }));
  }

  app.use('/health', healthRouter);
  app.use('/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

  // Inbound webhooks from external ninja services — registered BEFORE requireAuth (and before
  // the global express.json() below) so they can be called by server-to-server requests without
  // a Clerk browser session. Mounted with express.raw() rather than express.json(), matching the
  // /webhooks pattern above: HMAC verification must run over the exact bytes the sender signed —
  // re-serializing an already-parsed JSON body can diverge in number formatting, whitespace, or
  // key order and reject a legitimately-signed request.
  app.use('/api/integrations/ninja-task/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/integrations/crm/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/integrations', createNinjaTaskWebhookRouter(pool));
  app.use('/api/integrations', createCrmWebhookRouter(pool));

  // M34: CSV import posts the whole file as JSON (up to 500 rows) - larger limit on that path
  // only, mounted before the global parser (which then skips the already-parsed body).
  app.use('/api/tasks/import', express.json({ limit: '2mb' }));
  app.use(express.json());
  app.use('/public', shareRouter);
  app.use('/public/g', guestViewRouter);

  // External REST API — uses API key auth instead of Clerk; must be before requireAuth
  app.use('/api/external', externalRouter);

  // C2a: public invite lookup (GET /token/:token, rate-limited inside the router) must be
  // reachable without a Clerk session — the invitee usually isn't signed in yet. The accept
  // route in the same router carries its own per-route requireAuth.
  app.use('/api/invites',        publicInvitesRouter);

  // M46: public API docs (Swagger UI + openapi.json) — describes the API-key external API too,
  // and a browser can't attach a Clerk bearer token to a plain page load anyway.
  app.use('/api/docs', docsRouter);

  app.use('/api', requireAuth);

  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/workspaces', membersRouter);

  // Nested routers are mounted BEFORE their parent: each router runs its own requireWorkspace*
  // via router.use(), and a parent mounted first would run its middleware (including the viewer
  // write block) on the child's paths before falling through - which also defeated the per-router
  // requireWorkspaceAllowViewerWrites choice (H4) and doubled the membership query (L2).
  app.use('/api/tasks/import',   csvImportRouter);  // must be before tasksRouter to avoid /:id capture
  app.use('/api/tasks/:taskId/comments',         commentsRouter);
  app.use('/api/tasks/:taskId/dependencies',      taskDepsRouter);
  app.use('/api/tasks/:taskId/time-logs',         timeLogsRouter);
  app.use('/api/tasks/:taskId/watchers',          taskWatchersRouter);
  app.use('/api/tasks/:taskId/attachments',       attachmentsRouter);
  app.use('/api/tasks',                          tasksRouter);
  app.use('/api/goals/:goalId/key-results',       keyResultsRouter);
  app.use('/api/sprints/:sprintId/ai-summary',    aiSummaryRouter);
  app.use('/api/epics/:epicId/ai-summary',        epicAiSummaryRouter);
  app.use('/api/epics/:epicId/comments', epicCommentsRouter);
  app.use('/api/revenue',        revenueRouter);
  app.use('/api/roadmap',        roadmapRouter);
  app.use('/api/reviews',        reviewsRouter);
  app.use('/api/notifications',  notificationsRouter);
  app.use('/api/integrations',   integrationsRouter);
  app.use('/api/goals',          goalsRouter);
  app.use('/api/task-templates',                  taskTemplatesRouter);
  app.use('/api/sprints',        sprintsRouter);
  app.use('/api/webhooks',       webhookEndpointsRouter);
  app.use('/api/workspaces',     workspaceInvitesRouter);  // H1: admin invite management
  app.use('/api/epics',          epicsRouter);
  app.use('/api/clients',        clientsRouter);
  app.use('/api/budgets',        budgetsRouter);
  app.use('/api/changelog',      changelogRouter);
  app.use('/api/timeline',       timelineRouter);
  app.use('/api/support',        supportRouter);
  app.use('/api/ninja-stack',    ninjaStackRouter);
  app.use('/api/analytics',      analyticsRouter);
  app.use('/api/meeting-notes',  meetingNotesRouter);
  app.use('/api/sprint-templates', sprintTemplatesRouter);
  app.use('/api/epic-templates', epicTemplatesRouter);
  app.use('/api/project-shares', projectSharesRouter);
  app.use('/api/api-keys',       apiKeysRouter);
  app.use('/api/custom-fields',  customFieldsRouter);
  app.use('/api/automations',    automationsRouter);

  if (process.env.NODE_ENV === 'production') {
    // M8: Return JSON 404 for unmatched /api/* routes instead of serving index.html
    app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
    // index.html with the route's head tags; unknown paths get a real 404 (see lib/seoMeta.ts)
    const template = readFileSync(join(publicDir, 'index.html'), 'utf-8');
    app.get('*', (req, res) => {
      const { status, html } = renderSpaShell(template, req.path);
      res.status(status).type('html').send(html);
    });
  }

  app.use(errorHandler);
  return app;
}
