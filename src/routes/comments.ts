import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getComments, createComment, deleteComment } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';

const router = Router({ mergeParams: true }); // inherit :taskId from parent
router.use(requireWorkspace);

const createSchema = z.object({
  body: z.string().min(1).max(5000),
});

// GET /api/tasks/:taskId/comments
router.get('/', async (req, res, next) => {
  try {
    const comments = await getComments(req.params.taskId, req.workspace.id);
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

// POST /api/tasks/:taskId/comments
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    // Verify task belongs to workspace before inserting
    const taskResult = await pool.query<{ id: string; title: string; assignee_clerk_id: string | null; created_by: string }>(
      `SELECT id, title, assignee_clerk_id, created_by FROM tasks
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [req.params.taskId, req.workspace.id],
    );
    if (taskResult.rows.length === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const comment = await createComment(req.params.taskId, req.auth.userId, parsed.data.body);

    // Notify task owner + assignee (not the commenter themselves)
    const task = taskResult.rows[0];
    const recipients = new Set([task.created_by, task.assignee_clerk_id].filter(Boolean) as string[]);
    recipients.delete(req.auth.userId);

    for (const recipientClerkId of recipients) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId,
        type: 'comment_added',
        title: `New comment on "${task.title}"`,
        body: parsed.data.body.slice(0, 120),
        link: `/tasks`,
      }).catch(() => {}); // fire-and-forget, don't block response
    }

    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:taskId/comments/:commentId
router.delete('/:commentId', async (req, res, next) => {
  try {
    const deleted = await deleteComment(req.params.commentId, req.auth.userId, req.workspace.id);
    if (!deleted) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
