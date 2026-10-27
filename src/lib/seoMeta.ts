// Per-route <head> tags for the SPA shell. index.html ships the homepage's title, description and
// canonical; without this every URL (app routes, token pages, unknown paths) would send those to
// crawlers and link-preview bots that don't run JavaScript, and unknown paths would return 200.
// Titles/descriptions must match the <SeoHead> props of the page (client/src/components/SeoHead.tsx
// adds the " | Ninja Planner" suffix), so the tags don't change when React mounts.

import { getPublicAppUrl } from '../config/origins.js';

interface PageMeta {
  title: string;
  description: string;
  noIndex?: boolean;
  /** Document language: the public pages are Spanish (MX search), the signed-in app is English. */
  lang: 'es' | 'en';
}

const SUFFIX = ' | Ninja Planner';

export const HOME_DESCRIPTION =
  'Organiza las tareas, metas, roadmap y métricas de negocio de tu equipo en un solo lugar. Planificador para pymes en México y LATAM.';

// Public, indexable pages (keep in sync with client/public/sitemap.xml)
const PAGES: Record<string, PageMeta> = {
  '/': {
    title: `Planificador de Equipo y Dashboard Empresarial${SUFFIX}`,
    description: HOME_DESCRIPTION,
    lang: 'es',
  },
};

// The signed-in app (client/src/App.tsx). Never indexed.
const APP_ROUTES = new Set([
  '/dashboard',
  '/my-tasks',
  '/tasks',
  '/revenue',
  '/roadmap',
  '/reviews',
  '/workload',
  '/goals',
  '/sprints',
  '/epics',
  '/budgets',
  '/changelog',
  '/timeline',
  '/members',
  '/integrations',
  '/webhooks',
  '/analytics',
  '/meeting-notes',
  '/calendar',
  '/automations',
  '/task-templates',
  '/epic-templates',
  '/sprint-templates',
  '/clients',
  '/settings/billing',
  '/settings/api-keys',
  '/settings/custom-fields',
  '/settings/guest-links',
  '/settings/notifications',
]);

// Token pages (shared roadmaps, guest views, invites): real pages, never indexed.
const TOKEN_ROUTE_PATTERNS = [/^\/r\/[^/]+$/, /^\/g\/[^/]+$/, /^\/invite\/[^/]+$/];

const APP_META: PageMeta = { title: 'Ninja Planner', description: HOME_DESCRIPTION, noIndex: true, lang: 'en' };
// The token pages' UI is English (GuestView / PublicRoadmap / AcceptInvite)
const TOKEN_META: PageMeta = { title: 'Ninja Planner', description: HOME_DESCRIPTION, noIndex: true, lang: 'en' };
const NOT_FOUND_META: PageMeta = {
  title: `Página no encontrada${SUFFIX}`,
  description: HOME_DESCRIPTION,
  noIndex: true,
  lang: 'es',
};

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace the content="" of <meta {attr}="{key}" content="..."> (a missing tag is left as is)
function setMeta(html: string, attr: 'name' | 'property', key: string, content: string): string {
  const re = new RegExp(`(<meta\\s+${attr}="${escapeRegExp(key)}"\\s+content=")[^"]*(")`);
  return html.replace(re, (_m, start, end) => `${start}${escapeAttr(content)}${end}`);
}

/** Returns the status and the index.html for a client route, with that route's head tags. */
export function renderSpaShell(template: string, requestPath: string): { status: number; html: string } {
  // Same page with or without a trailing slash; the canonical never has one
  const path = requestPath.length > 1 ? requestPath.replace(/\/+$/, '') || '/' : requestPath;

  let status = 200;
  let meta: PageMeta;
  if (PAGES[path]) {
    meta = PAGES[path];
  } else if (APP_ROUTES.has(path)) {
    meta = APP_META;
  } else if (TOKEN_ROUTE_PATTERNS.some((re) => re.test(path))) {
    meta = TOKEN_META;
  } else {
    // Unknown path: the SPA still handles it (signed-in users are redirected to the dashboard),
    // but crawlers get a real 404
    status = 404;
    meta = NOT_FOUND_META;
  }

  // Token pages and unknown paths canonicalize to the homepage rather than echoing the token
  const url = `${getPublicAppUrl()}${PAGES[path] || APP_ROUTES.has(path) ? path : '/'}`;
  let html = template.replace(/<html lang="[^"]*"/, `<html lang="${meta.lang}"`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(meta.title)}</title>`);
  html = html.replace(/(<link rel="canonical" href=")[^"]*(")/, (_m, start, end) => `${start}${escapeAttr(url)}${end}`);
  html = setMeta(html, 'name', 'description', meta.description);
  html = setMeta(html, 'name', 'robots', meta.noIndex ? 'noindex, nofollow' : 'index, follow');
  html = setMeta(html, 'property', 'og:url', url);
  html = setMeta(html, 'property', 'og:title', meta.title);
  html = setMeta(html, 'property', 'og:description', meta.description);
  html = setMeta(html, 'name', 'twitter:url', url);
  html = setMeta(html, 'name', 'twitter:title', meta.title);
  html = setMeta(html, 'name', 'twitter:description', meta.description);
  return { status, html };
}
