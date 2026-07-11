import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getEpicComments, createEpicComment, deleteEpicComment } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';

const router = Router({ mergeParams: true }); // inherit :epicId from parent
router.use(requireWorkspace);

const createSchema = z.object({
  body: z.string().min(1).max(5000),
});

// GET /api/epics/:epicId/comments
router.get('/', async (req, res, next) => {
  try {
    const comments = await getEpicComments((req.params as Record<string, string>).epicId, req.workspace.id);
    res.json(comments);
  } catch (err) {
    next(err);
  }
});

// POST /api/epics/:epicId/comments
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const epicId = (req.params as Record<string, string>).epicId;
    const epicResult = await pool.query<{ id: string; title: string; created_by: string }>(
      `SELECT id, title, created_by FROM epics WHERE id = $1 AND workspace_id = $2`,
      [epicId, req.workspace.id],
    );
    if (epicResult.rows.length === 0) {
      res.status(404).json({ error: 'Epic not found' });
      return;
    }

    const comment = await createEpicComment(epicId, req.auth.userId, parsed.data.body);

    const epic = epicResult.rows[0];
    if (epic.created_by !== req.auth.userId) {
      createNotification({
        workspaceId: req.workspace.id,
        recipientClerkId: epic.created_by,
        type: 'comment_added',
        title: `New comment on "${epic.title}"`,
        body: comment.body.slice(0, 120),
        link: '/epics',
      }).catch(() => {});
    }

    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/epics/:epicId/comments/:commentId
router.delete('/:commentId', async (req, res, next) => {
  try {
    const deleted = await deleteEpicComment(req.params.commentId, req.auth.userId, req.workspace.id);
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
