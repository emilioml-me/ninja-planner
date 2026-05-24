// GET /api/docs — Swagger UI (development only)
// GET /api/docs/openapi.yaml — raw spec (always available)
import { Router }      from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import swaggerUi        from 'swagger-ui-express';
import yaml             from 'js-yaml';

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Raw spec (JSON) ────────────────────────────────────────────────────────
const specPath = join(__dirname, '../../openapi.yaml');
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
