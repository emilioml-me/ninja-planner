import { Router } from 'express';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { pool } from '../config/db.js';

// mergeParams: true — :taskId comes from the parent tasks router
const router = Router({ mergeParams: true });
router.use(requireWorkspace);

interface Watcher {
  user_clerk_id: string;
  display_name: string | null;
  created_at: string;
}

// GET /api/tasks/:taskId/watchers
router.get('/', async (req, res, next) => {
  try {
    const check = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    const result = await pool.query<Watcher>(
      `SELECT tw.user_clerk_id, wm.display_name, tw.created_at
       FROM   task_watchers tw
       LEFT JOIN workspace_members wm
              ON wm.clerk_user_id = tw.user_clerk_id
             AND wm.workspace_id  = tw.workspace_id
       WHERE  tw.task_id      = $1
         AND  tw.workspace_id = $2
       ORDER  BY tw.created_at ASC`,
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/tasks/:taskId/watchers  — current user watches this task
router.post('/', async (req, res, next) => {
  try {
    const check = await pool.query(
      'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    if (check.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }

    await pool.query(
      `INSERT INTO task_watchers (task_id, workspace_id, user_clerk_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [(req.params as Record<string, string>).taskId, req.workspace.id, req.auth.userId],
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:taskId/watchers  — current user unwatches
router.delete('/', async (req, res, next) => {
  try {
    await pool.query(
      `DELETE FROM task_watchers
       WHERE task_id = $1 AND workspace_id = $2 AND user_clerk_id = $3`,
      [(req.params as Record<string, string>).taskId, req.workspace.id, req.auth.userId],
    );
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
