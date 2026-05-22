import { describe, it, expect, vi, beforeAll } from 'vitest';
import request from 'supertest';

// ── Mock heavy modules before importing app ─────────────────────────────────
vi.mock('../config/db.js', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn() },
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: vi.fn(() => ({ verifyToken: vi.fn() })),
}));
vi.mock('../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Stub all auth & workspace middleware so tests reach the route handler
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware/requireWorkspace.js', () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
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

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });
});
