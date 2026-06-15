// External REST API — authenticated via API key (Bearer np_...) instead of Clerk session
// Mount: /api/external (before requireAuth in app.ts)
import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { apiKeyAuth, requireScope } from '../middleware/apiKeyAuth.js';

const router = Router();
router.use(apiKeyAuth);

const STATUS  = ['todo', 'in_progress', 'done', 'blocked'] as const;
const PRIORITY = ['urgent', 'high', 'medium', 'low'] as const;

// GET /api/external/tasks  [tasks:read]
router.get('/tasks', requireScope('tasks:read'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, status, priority, assignee_clerk_id, due_date, story_points, sprint_id, created_at, updated_at
       FROM tasks
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 200`,
      [req.workspace.id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/external/tasks  [tasks:write]
router.post('/tasks', requireScope('tasks:write'), async (req, res, next) => {
  try {
    const schema = z.object({
      title:    z.string().min(1).max(500),
      status:   z.enum(STATUS).default('todo'),
      priority: z.enum(PRIORITY).default('medium'),
      due_date: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const { title, status, priority, due_date } = parsed.data;
    const { rows } = await pool.query(
      `INSERT INTO tasks (workspace_id, title, status, priority, due_date)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, title, status, priority, due_date, created_at`,
      [req.workspace.id, title, status, priority, due_date ?? null],
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/external/tasks/:id  [tasks:write]
router.patch('/tasks/:id', requireScope('tasks:write'), async (req, res, next) => {
  try {
    const schema = z.object({
      title:    z.string().min(1).max(500).optional(),
      status:   z.enum(STATUS).optional(),
      priority: z.enum(PRIORITY).optional(),
      due_date: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const ALLOWED = ['title', 'status', 'priority', 'due_date'] as const;
    for (const key of ALLOWED) {
      if (key in parsed.data) {
        fields.push(`${key} = $${i++}`);
        values.push((parsed.data as Record<string, unknown>)[key] ?? null);
      }
    }
    if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    values.push(req.params.id, req.workspace.id);

    const { rows } = await pool.query(
      `UPDATE tasks SET ${fields.join(', ')}, updated_at = now()
       WHERE id = $${i++} AND workspace_id = $${i} AND deleted_at IS NULL
       RETURNING id, title, status, priority, due_date, updated_at`,
      values,
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

export default router;
