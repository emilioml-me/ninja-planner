import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
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
  verifyToken: vi.fn(),
  createClerkClient: vi.fn(() => ({ verifyToken: vi.fn() })),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.auth = { userId: 'user_test123' };
    next();
  },
}));
vi.mock('../middleware/requireWorkspace.js', () => {
  const stub = (req: any, _res: any, next: any) => {
    req.workspace = { id: 'ws_test', clerk_org_id: 'org_test' };
    next();
  };
  return { requireWorkspace: stub, requireWorkspaceAllowViewerWrites: stub };
});
vi.mock('../middleware/requireAdmin.js', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
// Stub email + notification side-effects. Partial mocks keep every other export of the real
// modules (routes import more than these), so a new export can't make app import fail.
vi.mock('../services/emailService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/emailService.js')>()),
  sendTaskAssignedEmail:    vi.fn().mockResolvedValue(undefined),
  sendDueDateReminderEmail: vi.fn().mockResolvedValue(undefined),
  sendGoalMilestoneEmail:   vi.fn().mockResolvedValue(undefined),
  resolveClerkEmail:        vi.fn().mockResolvedValue(null),
}));
vi.mock('../services/notificationService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notificationService.js')>()),
  createNotification: vi.fn().mockResolvedValue(undefined),
}));
// Partial mock: keep the module's other exports (e.g. ALL_EVENTS, imported at load time by
// routes/webhook-endpoints.ts) and only stub the network side effect.
vi.mock('../services/webhookService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/webhookService.js')>()),
  fireWebhooks: vi.fn().mockResolvedValue(undefined),
}));

const TASK_ROW = {
  id: 'task_001', title: 'Test task', description: null, status: 'todo',
  priority: 'medium', workspace_id: 'ws_test', creator_clerk_id: 'user_test123',
  assignee_clerk_id: null, due_date: null, start_date: null, tags: [],
  checklist: [], story_points: null, sprint_id: null, epic_id: null,
  recurrence_rule: null, created_at: new Date(), updated_at: new Date(),
  deleted_at: null, assignee_name: null,
};

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

beforeEach(() => {
  // mockReset drops unconsumed mockResolvedValueOnce values (clearAllMocks keeps them queued);
  // any query a test didn't script gets an empty result set.
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

afterEach(() => vi.clearAllMocks());

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('GET /api/tasks', () => {
  it('returns task list', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 });

    const res = await request(app).get('/api/tasks');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: 'task_001', title: 'Test task' });
  });

  it('accepts status filter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get('/api/tasks?status=done');

    expect(res.status).toBe(200);
    // Verify the query was parameterised (not a raw string injection)
    const [[sql]] = mockQuery.mock.calls;
    expect(sql).toContain('$');
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and returns 201', async () => {
    // No assignee, so no member lookup: the first query is the INSERT ... RETURNING.
    mockQuery.mockResolvedValueOnce({ rows: [TASK_ROW] });

    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'New task', status: 'todo', priority: 'medium' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Test task' });
  });

  it('rejects missing title', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ status: 'todo' });

    expect(res.status).toBe(400);
  });

  it('rejects invalid status enum', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Task', status: 'purple' });

    expect(res.status).toBe(400);
  });

  it('rejects invalid priority enum', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .send({ title: 'Task', status: 'todo', priority: 'catastrophic' });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('soft-deletes existing task', async () => {
    // softDeleteTask: single UPDATE returning rowCount > 0
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete('/api/tasks/task_001');
    expect([200, 204]).toContain(res.status);
  });

  it('returns 404 for unknown task', async () => {
    // softDeleteTask: rowCount = 0 → not found
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete('/api/tasks/task_unknown');
    expect(res.status).toBe(404);
  });
});
