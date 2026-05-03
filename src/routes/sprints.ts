import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getSprints, createSprint, updateSprint, deleteSprint, getSprintTasks,
} from '../services/sprintService.js';
import { pool } from '../config/db.js';

const router = Router();
router.use(requireWorkspace);

const SPRINT_STATUSES = ['planning', 'active', 'completed'] as const;

const createSchema = z.object({
  name:       z.string().min(1).max(255),
  goal:       z.string().optional(),
  status:     z.enum(SPRINT_STATUSES).optional(),
  start_date: z.string().date().optional(),
  end_date:   z.string().date().optional(),
});

const updateSchema = createSchema.partial();

// GET /api/sprints
router.get('/', async (req, res, next) => {
  try {
    res.json(await getSprints(req.workspace.id));
  } catch (err) { next(err); }
});

// POST /api/sprints
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    res.status(201).json(await createSprint(req.workspace.id, parsed.data, req.auth.userId));
  } catch (err) { next(err); }
});

// PATCH /api/sprints/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const sprint = await updateSprint(req.params.id, req.workspace.id, parsed.data);
    if (!sprint) { res.status(404).json({ error: 'Sprint not found' }); return; }
    res.json(sprint);
  } catch (err) { next(err); }
});

// DELETE /api/sprints/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await deleteSprint(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Sprint not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/sprints/:id/tasks
router.get('/:id/tasks', async (req, res, next) => {
  try {
    res.json(await getSprintTasks(req.params.id, req.workspace.id));
  } catch (err) { next(err); }
});

// PATCH /api/sprints/:id/tasks  — bulk assign tasks to sprint
router.patch('/:id/tasks', async (req, res, next) => {
  try {
    const schema = z.object({ task_ids: z.array(z.string().uuid()).min(1).max(100) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    // verify sprint belongs to workspace
    const sprintCheck = await pool.query(
      'SELECT id FROM sprints WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspace.id],
    );
    if (sprintCheck.rows.length === 0) { res.status(404).json({ error: 'Sprint not found' }); return; }

    await pool.query(
      `UPDATE tasks SET sprint_id = $1
       WHERE id = ANY($2::uuid[]) AND workspace_id = $3 AND deleted_at IS NULL`,
      [req.params.id, parsed.data.task_ids, req.workspace.id],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/sprints/:id/tasks/:taskId  — remove task from sprint
router.delete('/:id/tasks/:taskId', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE tasks SET sprint_id = NULL
       WHERE id = $1 AND sprint_id = $2 AND workspace_id = $3 AND deleted_at IS NULL`,
      [req.params.taskId, req.params.id, req.workspace.id],
    );
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
