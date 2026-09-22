// GET /api/docs — Swagger UI (public, mounted before requireAuth in app.ts)
// GET /api/docs/openapi.json — raw spec as JSON (public)
import { Router }      from 'express';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import swaggerUi        from 'swagger-ui-express';
import yaml             from 'js-yaml';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Raw spec (JSON) ────────────────────────────────────────────────────────
// Dev (tsx): src/routes -> ../../openapi.yaml. Prod bundle: dist/index.js -> ../openapi.yaml (/app/openapi.yaml).
const specPath =
  [join(__dirname, '../../openapi.yaml'), join(__dirname, '../openapi.yaml'), join(process.cwd(), 'openapi.yaml')]
    .find((p) => existsSync(p)) ?? join(process.cwd(), 'openapi.yaml');
let spec: Record<string, unknown> | null = null;

function loadSpec(): Record<string, unknown> {
  if (!spec) {
    spec = yaml.load(readFileSync(specPath, 'utf-8')) as Record<string, unknown>;
  }
  return spec;
}

router.get('/openapi.json', (_req, res) => {
  try {
    res.json(loadSpec());
  } catch {
    res.status(500).json({ error: 'Failed to load OpenAPI spec' });
  }
});

// ── Swagger UI ────────────────────────────────────────────────────────────
router.use('/', swaggerUi.serve);
router.get('/', swaggerUi.setup(undefined, {
  swaggerOptions: { url: '/api/docs/openapi.json' },
  customSiteTitle: 'Ninja Planner API Docs',
}));

export default router;
