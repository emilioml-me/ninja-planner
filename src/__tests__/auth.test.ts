import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';

// ── Mocks — must be at module top level ─────────────────────────────────────
vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() },
}));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// middleware/auth.ts imports the standalone `verifyToken` export from @clerk/backend (not the
// method on a createClerkClient() instance), so that is the export that must be mocked for these
// tests to exercise the real middleware. vi.hoisted makes the mock fn usable inside vi.mock.
const { mockVerifyToken } = vi.hoisted(() => ({ mockVerifyToken: vi.fn() }));
vi.mock('@clerk/backend', () => ({
  verifyToken: mockVerifyToken,
  createClerkClient: vi.fn(() => ({})),
}));
// requireWorkspace returns 403 — but auth middleware runs first and returns 401
vi.mock('../middleware/requireWorkspace.js', () => ({
  requireWorkspace: (_req: any, res: any, _next: any) => {
    res.status(403).json({ error: 'workspace_required' });
  },
}));

let app: any;
const ORIGINAL_ENV = { ...process.env };
beforeAll(async () => {
  process.env.CLERK_SECRET_KEY     = 'test';
  process.env.CLERK_WEBHOOK_SECRET = 'test';
  process.env.DATABASE_URL         = 'postgresql://test';
  process.env.NODE_ENV             = 'test';
  const { createApp } = await import('../app.js');
  app = createApp();
});

afterEach(() => {
  mockVerifyToken.mockReset();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('Auth middleware', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('rejects requests with a non-Bearer Authorization header', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('rejects a token that Clerk fails to verify', async () => {
    mockVerifyToken.mockRejectedValueOnce(new Error('invalid token'));
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
    expect(mockVerifyToken).toHaveBeenCalledTimes(1);
    expect(mockVerifyToken.mock.calls[0][0]).toBe('not-a-real-token');
  });

  it('passes a verified token through to the next middleware', async () => {
    mockVerifyToken.mockResolvedValueOnce({ sub: 'user_123', o: { id: 'org_123' } });
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer valid-token');
    // Auth succeeded, so the request reaches the (mocked) requireWorkspace, which answers 403.
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'workspace_required' });
  });
});

describe('Protected routes without auth', () => {
  const protectedPaths = [
    '/api/tasks',
    '/api/sprints',
    '/api/goals',
    '/api/roadmap',
    '/api/timeline',
  ];

  for (const path of protectedPaths) {
    it(`GET ${path} → 401 without token`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    });
  }
});
