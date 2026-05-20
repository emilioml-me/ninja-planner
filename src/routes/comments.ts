import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getComments, createComment, deleteComment } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';
import { sendCommentMentionEmail, resolveClerkEmail } from '../services/emailService.js';

const router = Router({ mergeParams: true }); // inherit :taskId from parent
router.use(requireWorkspace);

const createSchema = z.object({
  body:     z.string().min(1).max(5000),
  mentions: z.array(z.string()).max(20).optional(), // clerk_ids of mentioned workspace members
});

// GET /api/tasks/:taskId/comments
router.get('/', async (req, res, next) => {
  try {
    const comments = await getComments((req.params as Record<string, string>).taskId, req.workspace.id);
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
      [(req.params as Record<string, string>).taskId, req.workspace.id],
    );
    if (taskResult.rows.length === 0) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    const comment = await createComment((req.params as Record<string, string>).taskId, req.auth.userId, parsed.data.body);

    // Notify task owner + assignee (not the commenter themselves)
    const task = taskResult.rows[0];
    const recipients = new Set([task.created_by, task.assignee_clerk_id].filter(Boolean) as string[]);
    recipients.delete(req.auth.userId);

    // Resolve commenter name once for email (fire-and-forget)
    resolveClerkEmail(req.auth.userId).then((commenter) => {
      for (const recipientClerkId of recipients) {
        createNotification({
          workspaceId: req.workspace.id,
          recipientClerkId,
          type: 'comment_added',
          title: `New comment on "${task.title}"`,
          body: comment.body.slice(0, 120),
          link: `/tasks`,
        }).catch(() => {});

        resolveClerkEmail(recipientClerkId).then((recipient) => {
          if (!recipient) return;
          return sendCommentMentionEmail({
            to: recipient.email,
            recipientName: recipient.name,
            commenter: commenter?.name ?? 'A teammate',
            taskTitle: task.title,
            commentBody: parsed.data.body,
            workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
          });
        }).catch(() => {});
      }
    }).catch(() => {
      // Fallback: still send in-app notifications even if email resolution fails
      for (const recipientClerkId of recipients) {
        createNotification({
          workspaceId: req.workspace.id,
          recipientClerkId,
          type: 'comment_added',
          title: `New comment on "${task.title}"`,
          body: comment.body.slice(0, 120),
          link: `/tasks`,
        }).catch(() => {});
      }
    });

    // @mention notifications — validate mentions are workspace members, then notify
    if (parsed.data.mentions?.length) {
      const mentionIds = parsed.data.mentions;
      // Validate all mentioned IDs are actually workspace members
      const memberCheck = await pool.query<{ clerk_user_id: string }>(
        `SELECT clerk_user_id FROM workspace_members
         WHERE workspace_id = $1 AND clerk_user_id = ANY($2)`,
        [req.workspace.id, mentionIds],
      );
      const validMentions = new Set(memberCheck.rows.map((r) => r.clerk_user_id));
      validMentions.delete(req.auth.userId); // don't notify self

      for (const mentionedId of validMentions) {
        if (recipients.has(mentionedId)) continue; // already notified above
        createNotification({
          workspaceId: req.workspace.id,
          recipientClerkId: mentionedId,
          type: 'mention',
          title: `You were mentioned in "${task.title}"`,
          body: comment.body.slice(0, 120),
          link: `/tasks`,
        }).catch(() => {});

        // Email: @mention
        Promise.all([
          resolveClerkEmail(mentionedId),
          resolveClerkEmail(req.auth.userId),
        ]).then(([recipient, commenter]) => {
          if (!recipient) return;
          return sendCommentMentionEmail({
            to: recipient.email,
            recipientName: recipient.name,
            commenter: commenter?.name ?? 'A teammate',
            taskTitle: task.title,
            commentBody: parsed.data.body,
            workspaceUrl: process.env.ALLOWED_ORIGIN ?? 'https://plan-ninja.com',
          });
        }).catch(() => {});
      }
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
