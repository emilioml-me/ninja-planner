import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { getEpicComments, createEpicComment } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';

const router = Router({ mergeParams: true }); // inherit :epicId from parent
router.use(requireWorkspace);

const createSchema = z.object({
  // trim first so a whitespace-only comment is rejected rather than stored as a blank comment
  body: z.string().trim().min(1).max(5000),
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
    // creator_is_member: the epic creator may have left the workspace — don't notify them then.
    const epicResult = await pool.query<{ id: string; title: string; created_by: string; creator_is_member: boolean }>(
      `SELECT e.id, e.title, e.created_by,
              EXISTS (
                SELECT 1 FROM workspace_members wm
                WHERE wm.workspace_id = e.workspace_id AND wm.clerk_user_id = e.created_by
              ) AS creator_is_member
       FROM epics e WHERE e.id = $1 AND e.workspace_id = $2`,
      [epicId, req.workspace.id],
    );
    if (epicResult.rows.length === 0) {
      res.status(404).json({ error: 'Epic not found' });
      return;
    }

    const comment = await createEpicComment(epicId, req.auth.userId, parsed.data.body);

    const epic = epicResult.rows[0];
    if (epic.created_by !== req.auth.userId && epic.creator_is_member) {
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
    // Scoped to the :epicId in the URL and the workspace, so the route can't delete a comment
    // belonging to another epic. Authors delete their own comments; admins can moderate any.
    const isAdmin = !!req.auth.memberRole && ADMIN_ROLES.has(req.auth.memberRole);
    const result = await pool.query(
      `DELETE FROM epic_comments ec
       USING epics e
       WHERE ec.id = $1
         AND ec.epic_id = $2
         AND (ec.author_clerk_id = $3 OR $5::boolean)
         AND e.id = ec.epic_id
         AND e.workspace_id = $4`,
      [req.params.commentId, (req.params as Record<string, string>).epicId, req.auth.userId, req.workspace.id, isAdmin],
    );
    if ((result.rowCount ?? 0) === 0) {
      res.status(404).json({ error: 'Comment not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
