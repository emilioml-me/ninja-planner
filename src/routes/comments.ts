import { Router } from 'express';
import { z } from 'zod';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { getComments, createComment, deleteComment } from '../services/commentService.js';
import { createNotification } from '../services/notificationService.js';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { getPublicAppUrl } from '../config/origins.js';
import { trackBackground } from '../lib/background.js';
import { sendCommentMentionEmail, sendCommentAddedEmail, resolveClerkEmail } from '../services/emailService.js';

const router = Router({ mergeParams: true }); // inherit :taskId from parent
router.use(requireWorkspace);

const createSchema = z.object({
  // trim BEFORE min(1) so whitespace-only comments are rejected
  body:     z.string().trim().min(1).max(5000),
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

    // Validate mentions against workspace membership BEFORE persisting — only real, current
    // members should ever end up in the stored (queryable) mentions list, not whatever the
    // client submitted.
    let validMentions = new Set<string>();
    if (parsed.data.mentions?.length) {
      const memberCheck = await pool.query<{ clerk_user_id: string }>(
        `SELECT clerk_user_id FROM workspace_members
         WHERE workspace_id = $1 AND clerk_user_id = ANY($2)`,
        [req.workspace.id, parsed.data.mentions],
      );
      validMentions = new Set(memberCheck.rows.map((r) => r.clerk_user_id));
      validMentions.delete(req.auth.userId); // don't notify/store self-mentions
    }

    const comment = await createComment(
      (req.params as Record<string, string>).taskId,
      req.auth.userId,
      parsed.data.body,
      [...validMentions],
    );

    // Notify task owner + assignee (not the commenter themselves). Mentioned users get the
    // 'mention' notification instead of 'comment_added' (one notification per person).
    const task = taskResult.rows[0];
    const workspaceId = req.workspace.id;
    const commenterId = req.auth.userId;
    const workspaceUrl = getPublicAppUrl();
    const candidates = new Set([task.created_by, task.assignee_clerk_id].filter(Boolean) as string[]);
    candidates.delete(commenterId);
    for (const id of validMentions) candidates.delete(id);

    // Fire-and-forget: notification fan-out must never delay or fail the comment response.
    // Tracked so a graceful shutdown waits for it.
    trackBackground((async () => {
      // Only CURRENT members get anything — the task's creator/assignee may have left the
      // workspace since (mentions were already validated against membership above).
      let recipients: string[] = [];
      if (candidates.size > 0) {
        const memberRes = await pool.query<{ clerk_user_id: string }>(
          `SELECT clerk_user_id FROM workspace_members
           WHERE workspace_id = $1 AND clerk_user_id = ANY($2)`,
          [workspaceId, [...candidates]],
        );
        recipients = memberRes.rows.map((r) => r.clerk_user_id);
      }

      const commenter = await resolveClerkEmail(commenterId);
      const commenterName = commenter?.name ?? 'A teammate';

      const notify = async (recipientClerkId: string, type: 'comment_added' | 'mention') => {
        // createNotification checks the recipient's preference and reports it, so the email
        // honours the same preference without a second lookup.
        const enabled = await createNotification({
          workspaceId,
          recipientClerkId,
          type,
          title: type === 'mention' ? `You were mentioned in "${task.title}"` : `New comment on "${task.title}"`,
          body: comment.body.slice(0, 120),
          link: `/tasks?task=${encodeURIComponent(task.id)}`,
        });
        if (!enabled) return;
        const recipient = await resolveClerkEmail(recipientClerkId);
        if (!recipient) return;
        const emailOpts = {
          to: recipient.email,
          recipientName: recipient.name,
          commenter: commenterName,
          taskTitle: task.title,
          commentBody: comment.body,
          workspaceUrl,
          taskId: task.id,
        };
        // "You were mentioned" only for actual mentions; owner/assignee get a plain comment email.
        if (type === 'mention') await sendCommentMentionEmail(emailOpts);
        else await sendCommentAddedEmail(emailOpts);
      };

      await Promise.allSettled([
        ...recipients.map((id) => notify(id, 'comment_added')),
        ...[...validMentions].map((id) => notify(id, 'mention')),
      ]);
    })()).catch((err) => {
      logger.warn({ err, taskId: task.id }, 'comment notification fan-out failed');
    });

    res.status(201).json(comment);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tasks/:taskId/comments/:commentId
router.delete('/:commentId', async (req, res, next) => {
  try {
    const deleted = await deleteComment(
      req.params.commentId,
      req.auth.userId,
      req.workspace.id,
      (req.params as Record<string, string>).taskId,
    );
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
