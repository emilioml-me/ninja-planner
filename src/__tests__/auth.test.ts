import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// ── Mocks — must be at module top level ─────────────────────────────────────
vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() },
}));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({
    verifyToken: vi.fn().mockRejectedValue(new Error('invalid token')),
  })),
}));
// requireWorkspace returns 403 — but auth middleware runs first and returns 401
vi.mock('../middleware/requireWorkspace.js', () => ({
  requireWorkspace: (_req: any, res: any, _next: any) => {
    res.status(403).json({ error: 'workspace_required' });
  },
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

describe('Auth middleware', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(401);
  });

  it('rejects requests with malformed bearer token', async () => {
    const res = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
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
