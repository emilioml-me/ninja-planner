import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import {
  getGoals, getGoalById, createGoal, updateGoal, deleteGoal,
  getGoalLinks, addGoalLink, removeGoalLink, getGoalOwner,
} from '../services/goalService.js';
import { dispatchAutomations } from '../services/automationService.js';
import { fireWebhooks } from '../services/webhookService.js';

const router = Router();
router.use(requireWorkspace);

// description / due_date accept null so the client can clear them; undefined = unchanged.
const createSchema = z.object({
  title:        z.string().min(1).max(500),
  description:  z.string().max(5000).nullable().optional(),
  due_date:     z.string().date().nullable().optional(),
});

const updateSchema = z.object({
  title:        z.string().min(1).max(500).optional(),
  description:  z.string().max(5000).nullable().optional(),
  status:       z.enum(['active', 'completed', 'cancelled']).optional(),
  due_date:     z.string().date().nullable().optional(),
});

const linkSchema = z.object({
  entity_type: z.enum(['task', 'roadmap_item']),
  entity_id:   z.string().uuid(),
});

// GET /api/goals
router.get('/', async (req, res, next) => {
  try {
    res.json(await getGoals(req.workspace.id));
  } catch (err) { next(err); }
});

// POST /api/goals
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    res.status(201).json(await createGoal(req.workspace.id, parsed.data, req.auth.userId));
  } catch (err) { next(err); }
});

// GET /api/goals/:id
router.get('/:id', async (req, res, next) => {
  try {
    const goal = await getGoalById(req.params.id, req.workspace.id);
    if (!goal) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.json(goal);
  } catch (err) { next(err); }
});

// PATCH /api/goals/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    const updated = await updateGoal(req.params.id, req.workspace.id, parsed.data);
    if (!updated) { res.status(404).json({ error: 'Goal not found' }); return; }
    const { prev_status: prevStatus, ...goal } = updated;
    // Only on the transition into 'completed' — re-saving a completed goal must not re-fire.
    if (goal.status === 'completed' && prevStatus !== 'completed') {
      fireWebhooks(req.workspace.id, 'goal.completed', { goal });
      dispatchAutomations({
        type: 'goal.completed',
        workspaceId: req.workspace.id,
        goalId: goal.id,
        title: goal.title,
      }).catch(() => {});
    }
    res.json(goal);
  } catch (err) { next(err); }
});

/**
 * Destructive goal operations (delete goal, unlink items, delete key results) are allowed for
 * workspace admins and for the goal's creator. Sends 404/403 and returns false otherwise.
 */
export async function canManageGoal(
  req: Request,
  res: Response,
  goalId: string,
): Promise<boolean> {
  const owner = await getGoalOwner(goalId, req.workspace.id);
  if (owner === null) { res.status(404).json({ error: 'Goal not found' }); return false; }
  const isAdmin = !!req.auth.memberRole && ADMIN_ROLES.has(req.auth.memberRole);
  if (!isAdmin && owner !== req.auth.userId) {
    res.status(403).json({ error: 'Only admins or the goal owner can do this' });
    return false;
  }
  return true;
}

// DELETE /api/goals/:id  [admin or goal owner]
router.delete('/:id', async (req, res, next) => {
  try {
    if (!(await canManageGoal(req, res, req.params.id))) return;
    const deleted = await deleteGoal(req.params.id, req.workspace.id);
    if (!deleted) { res.status(404).json({ error: 'Goal not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

// GET /api/goals/:id/links
router.get('/:id/links', async (req, res, next) => {
  try {
    res.json(await getGoalLinks(req.params.id, req.workspace.id));
  } catch (err) { next(err); }
});

// POST /api/goals/:id/links
router.post('/:id/links', async (req, res, next) => {
  try {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { entity_type, entity_id } = parsed.data;

    // Verify entity belongs to THIS workspace (prevents cross-workspace linking)
    if (entity_type === 'task') {
      const check = await pool.query(
        'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
        [entity_id, req.workspace.id],
      );
      if (check.rows.length === 0) { res.status(404).json({ error: 'Task not found in workspace' }); return; }
    } else if (entity_type === 'roadmap_item') {
      const check = await pool.query(
        'SELECT id FROM roadmap_items WHERE id = $1 AND workspace_id = $2',
        [entity_id, req.workspace.id],
      );
      if (check.rows.length === 0) { res.status(404).json({ error: 'Roadmap item not found in workspace' }); return; }
    }

    const link = await addGoalLink(req.params.id, req.workspace.id, entity_type, entity_id);
    if (!link) { res.status(409).json({ error: 'Link already exists' }); return; }
    res.status(201).json(link);
  } catch (err) { next(err); }
});

// DELETE /api/goals/:id/links/:entityId  [admin or goal owner]
router.delete('/:id/links/:entityId', async (req, res, next) => {
  try {
    if (!z.string().uuid().safeParse(req.params.entityId).success) {
      res.status(400).json({ error: 'Invalid entity id' }); return;
    }
    if (!(await canManageGoal(req, res, req.params.id))) return;
    const deleted = await removeGoalLink(req.params.id, req.workspace.id, req.params.entityId);
    if (!deleted) { res.status(404).json({ error: 'Link not found' }); return; }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
