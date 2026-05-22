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
    req.auth = { userId: 'user_test123' };
    next();
  },
}));
vi.mock('../middleware/requireWorkspace.js', () => ({
  requireWorkspace: (req: any, _res: any, next: any) => {
    req.workspace = { id: 'ws_test', clerk_org_id: 'org_test' };
    next();
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

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DESK_NINJA_API_KEY;
});

describe('POST /api/support/ticket', () => {
  it('returns 503 when DESK_NINJA_API_KEY is not set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ display_name: 'Alice', email: 'alice@example.com' }] });

    const res = await request(app)
      .post('/api/support/ticket')
      .send({ subject: 'Bug report', description: 'Something broke', priority: 'high' });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not available/i);
  });

  it('returns 400 for missing subject', async () => {
    process.env.DESK_NINJA_API_KEY = 'dnk_test';
    mockQuery.mockResolvedValueOnce({ rows: [{ display_name: 'Alice', email: 'alice@example.com' }] });

    const res = await request(app)
      .post('/api/support/ticket')
      .send({ description: 'No subject here' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing description', async () => {
    process.env.DESK_NINJA_API_KEY = 'dnk_test';
    const res = await request(app)
      .post('/api/support/ticket')
      .send({ subject: 'Test' });

    expect(res.status).toBe(400);
  });

  it('forwards ticket to desk-ninja and returns ticket number', async () => {
    process.env.DESK_NINJA_API_KEY = 'dnk_test';
    process.env.DESK_NINJA_URL     = 'http://desk-ninja-mock';

    mockQuery.mockResolvedValueOnce({ rows: [{ display_name: 'Alice', email: 'alice@example.com' }] });

    // Mock the fetch to desk-ninja
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ticketNumber: 'TKT-0042', portalUrl: 'http://desk-ninja-mock/portal' }),
    } as any);

    const res = await request(app)
      .post('/api/support/ticket')
      .send({ subject: 'Bug report', description: 'Something is broken', priority: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.ticketNumber).toBe('TKT-0042');
    expect(res.body.portalUrl).toBeDefined();

    // Verify fetch was called with correct payload
    const fetchCall = (global.fetch as any).mock.calls[0];
    const fetchBody = JSON.parse(fetchCall[1].body);
    expect(fetchBody.customerEmail).toBe('alice@example.com');
    expect(fetchBody.tags).toContain('plan-ninja');
  });

  it('propagates desk-ninja error status', async () => {
    process.env.DESK_NINJA_API_KEY = 'dnk_test';
    process.env.DESK_NINJA_URL     = 'http://desk-ninja-mock';

    mockQuery.mockResolvedValueOnce({ rows: [{ display_name: 'Alice', email: 'alice@example.com' }] });

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Ticket limit reached' }),
    } as any);

    const res = await request(app)
      .post('/api/support/ticket')
      .send({ subject: 'Bug', description: 'Details', priority: 'medium' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/limit/i);
  });
});
