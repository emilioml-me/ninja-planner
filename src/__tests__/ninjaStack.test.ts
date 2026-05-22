import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';

// ── Mocks ────────────────────────────────────────────────────────────────────
const mockQuery = vi.fn();

vi.mock('../config/db.js', () => ({
  pool: { query: mockQuery, end: vi.fn() },
}));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({ verifyToken: vi.fn() })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.auth = { userId: 'user_admin' };
    next();
  },
}));
vi.mock('../middleware/requireWorkspace.js', () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspace = { id: 'ws_test', clerk_org_id: 'org_test' };
    next();
  },
}));
vi.mock('../middleware/requireAdmin.js', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

let app: any;
beforeAll(async () => {
  process.env.CLERK_SECRET_KEY     = 'test';
  process.env.CLERK_WEBHOOK_SECRET = 'test';
  process.env.DATABASE_URL         = 'postgresql://test';
  process.env.NODE_ENV             = 'test';
  const { createApp } = await import('../app.js');
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe('GET /api/ninja-stack/status', () => {
  it('returns no_code when workspace has no subscription', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/ninja-stack/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false, reason: 'no_code' });
  });

  it('returns active when subscription exists and is current', async () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    mockQuery.mockResolvedValueOnce({
      rows: [{
        code: 'nsk_test', plan: 'pro', expires_at: future,
        last_verified_at: recent, admin_override: false,
      }],
    });

    const res = await request(app).get('/api/ninja-stack/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: true, plan: 'pro' });
  });

  it('returns expired when subscription has passed its expiry', async () => {
    const past = new Date(Date.now() - 1000);
    mockQuery.mockResolvedValueOnce({
      rows: [{
        code: 'nsk_old', plan: 'starter', expires_at: past,
        last_verified_at: past, admin_override: false,
      }],
    });

    const res = await request(app).get('/api/ninja-stack/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ active: false, reason: 'expired' });
  });
});

describe('POST /api/ninja-stack/activate', () => {
  it('returns 400 when code is missing', async () => {
    const res = await request(app)
      .post('/api/ninja-stack/activate')
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 502 when ninja-core is unreachable', async () => {
    process.env.NINJA_CORE_APP_ID     = 'app_test';
    process.env.NINJA_CORE_APP_SECRET = 'secret_test';
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network error'));

    const res = await request(app)
      .post('/api/ninja-stack/activate')
      .send({ code: 'nsk_test' });

    expect(res.status).toBe(502);

    delete process.env.NINJA_CORE_APP_ID;
    delete process.env.NINJA_CORE_APP_SECRET;
  });
});
