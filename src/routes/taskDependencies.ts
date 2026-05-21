import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import {
  getDependencies,
  addDependency,
  removeDependency,
} from '../services/dependencyService.js';

// Mounted at /api/tasks/:taskId/dependencies  (mergeParams: true)
const router = Router({ mergeParams: true });
router.use(requireWorkspace);

// GET /api/tasks/:taskId/dependencies
router.get('/', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    const deps = await getDependencies(taskId, req.workspace.id);
    res.json(deps);
  } catch (err) { next(err); }
});

const addSchema = z.object({
  /**
   * direction: 'blocked_by' means THIS task is blocked by the provided task_id.
   *            'blocks'     means THIS task blocks the provided task_id.
   */
  task_id:   z.string().uuid(),
  direction: z.enum(['blocked_by', 'blocks']),
});

// POST /api/tasks/:taskId/dependencies
router.post('/', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    const parsed = addSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { task_id, direction } = parsed.data;

    const [blockingId, blockedId] =
      direction === 'blocked_by'
        ? [task_id, taskId]   // task_id blocks this task
        : [taskId, task_id];  // this task blocks task_id

    const dep = await addDependency(blockingId, blockedId, req.workspace.id, req.auth.userId);
    if (dep === null) {
      res.status(409).json({ error: 'Dependency already exists, would create a cycle, or task not found' });
      return;
    }
    res.status(201).json(dep);
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:taskId/dependencies/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const removed = await removeDependency(req.params.id, req.workspace.id);
    if (!removed) {
      res.status(404).json({ error: 'Dependency not found' });
      return;
    }
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
