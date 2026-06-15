import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  getRoadmap,
  createRoadmapItem,
  updateRoadmapItem,
  deleteRoadmapItem,
} from '../services/roadmapService.js';
import { regenerateShareToken, getShareToken, revokeShareToken } from '../services/shareService.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const STATUSES = ['idea', 'building', 'live', 'archived'] as const;

// M5: Validate filter query params — enum check on status, length cap on phase
const filterSchema = z.object({
  status: z.enum(STATUSES).optional(),
  phase:  z.string().max(100).optional(),
});

const createSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().optional(),
  phase:        z.string().max(100).optional(),
  status:       z.enum(STATUSES).optional(),
  priority:     z.number().int().min(0).optional(),
  external_ref: z.string().url().max(500).nullable().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/roadmap
router.get('/', async (req, res, next) => {
  try {
    const parsed = filterSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const filters = parsed.data;
    const items = await getRoadmap(req.workspace.id, filters);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// POST /api/roadmap  [admin only]
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const item = await createRoadmapItem(req.workspace.id, parsed.data);
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/roadmap/reorder  — bulk priority update for drag-to-reorder  [admin only]
// Body: { items: [{ id: string, priority: number }] }
// Must be registered before PATCH /:id so Express doesn't treat "reorder" as an id param.
router.patch('/reorder', requireAdmin, async (req, res, next) => {
  try {
    const schema = z.object({
      items: z.array(z.object({ id: z.string().uuid(), priority: z.number().int().min(0) })).min(1).max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    // Use a single unnest-based UPDATE for efficiency
    const ids       = parsed.data.items.map((i) => i.id);
    const priorities = parsed.data.items.map((i) => i.priority);
    await pool.query(
      `UPDATE roadmap_items ri
       SET priority = v.priority::int
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::int[]) AS priority) v
       WHERE ri.id = v.id AND ri.workspace_id = $3`,
      [ids, priorities, req.workspace.id],
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/roadmap/:id  [admin only]
// Must be after PATCH /reorder so the literal route matches first.
router.patch('/:id', requireAdmin, async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }
    const item = await updateRoadmapItem(req.params.id, req.workspace.id, parsed.data);
    if (!item) {
      res.status(404).json({ error: 'Roadmap item not found' });
      return;
    }
    res.json(item);

    // Phase 6 — Roadmap → GTD Capture: when an item moves to "building" (in-progress),
    // push it to the ninja-task GTD inbox for every non-guest workspace member.
    // Fire-and-forget; response has already been sent above.
    if (parsed.data.status === 'building' && process.env.NINJA_TASK_URL && process.env.NINJA_TASK_API_KEY) {
      pool.query<{ clerk_user_id: string }>(
        "SELECT clerk_user_id FROM workspace_members WHERE workspace_id = $1 AND role != 'guest'",
        [req.workspace.id],
      ).then(async (membersResult) => {
        const { captureToNinjaTaskGtd } = await import("../integrations/ninjatask.js");
        for (const member of membersResult.rows) {
          try {
            await captureToNinjaTaskGtd({
              title: item.title,
              clerkId: member.clerk_user_id,
            });
          } catch (err) {
            console.error("[ninja-task] GTD capture failed for:", member.clerk_user_id, err);
          }
        }
      }).catch((err: Error) => console.error("[ninja-task] GTD roadmap push failed:", err));
    }
  } catch (err) {
    next(err);
  }
});

// ─── Share token management ───────────────────────────────────────────────────
// All /share routes must be registered before DELETE /:id so Express doesn't
// treat the literal string "share" as an id param.

// GET /api/roadmap/share  — get current token (admin only; null if none)
router.get('/share', requireAdmin, async (req, res, next) => {
  try {
    const st = await getShareToken(req.workspace.id, 'roadmap');
    res.json({ token: st?.token ?? null });
  } catch (err) { next(err); }
});

// POST /api/roadmap/share  — always generate a fresh token (invalidates previous)  [admin only]
router.post('/share', requireAdmin, async (req, res, next) => {
  try {
    const st = await regenerateShareToken(req.workspace.id, 'roadmap', req.auth.userId);
    res.json({ token: st.token });
  } catch (err) { next(err); }
});

// DELETE /api/roadmap/share  — revoke token  [admin only]
router.delete('/share', requireAdmin, async (req, res, next) => {
  try {
    await revokeShareToken(req.workspace.id, 'roadmap');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/roadmap/:id  [admin only]
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const deleted = await deleteRoadmapItem(req.params.id, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Roadmap item not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Task links ──────────────────────────────────────────────────────────────

// GET /api/roadmap/:id/tasks  — list tasks linked to this roadmap item
router.get('/:id/tasks', async (req, res, next) => {
  try {
    // Verify item belongs to workspace
    const itemCheck = await pool.query<{ id: string }>(
      'SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (itemCheck.rows.length === 0) { res.status(404).json({ error: 'Roadmap item not found' }); return; }

    const result = await pool.query(
      `SELECT t.id, t.title, t.status, t.priority, t.assignee_clerk_id
       FROM roadmap_task_links rtl
       JOIN tasks t ON t.id = rtl.task_id
       WHERE rtl.roadmap_item_id = $1 AND t.workspace_id = $2 AND t.deleted_at IS NULL
       ORDER BY t.created_at`,
      [req.params.id, req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/roadmap/:id/tasks  — link a task  [admin only]
router.post('/:id/tasks', requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ taskId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    // Verify both item and task belong to the workspace
    const [itemCheck, taskCheck] = await Promise.all([
      pool.query<{ id: string }>('SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2', [req.params.id, req.workspace.id]),
      pool.query<{ id: string }>('SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL', [parsed.data.taskId, req.workspace.id]),
    ]);
    if (itemCheck.rows.length === 0) { res.status(404).json({ error: 'Roadmap item not found' }); return; }
    if (taskCheck.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    await pool.query(
      `INSERT INTO roadmap_task_links (roadmap_item_id, task_id, workspace_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, parsed.data.taskId, req.workspace.id],
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/roadmap/:id/tasks/:taskId  — unlink a task  [admin only]
router.delete('/:id/tasks/:taskId', requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query(
      `DELETE FROM roadmap_task_links
       WHERE roadmap_item_id = $1 AND task_id = $2
         AND workspace_id = $3`,
      [req.params.id, req.params.taskId, req.workspace.id],
    );
    if ((result.rowCount ?? 0) === 0) { res.status(404).json({ error: 'Link not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
