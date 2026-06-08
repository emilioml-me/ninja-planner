import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import rateLimit from 'express-rate-limit';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import { getUploadUrl, getDownloadUrl, deleteObject, verifyObjectMimeType } from '../lib/r2.js';

// mergeParams: true — :taskId comes from the parent tasks router
const router = Router({ mergeParams: true });
router.use(requireWorkspace);
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const ALLOWED_MIME  = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv', 'text/markdown',
  'application/zip',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/wav',
  // NOTE: image/svg+xml intentionally excluded — stored XSS risk
]);

/** Sanitize a user-supplied filename: strip path separators, null bytes, and dangerous sequences (H4) */
function sanitizeFileName(name: string): string {
  return name
    .replace(/\0/g, '')          // null bytes
    .replace(/[/\\]/g, '_')      // path separators
    .replace(/^\.+$/, '_');      // bare dot/dotdot
}

const presignSchema = z.object({
  file_name: z.string().min(1).max(255),
  file_size: z.number().int().min(1).max(MAX_FILE_SIZE),
  mime_type: z.string().min(1).max(100),
});

const confirmSchema = z.object({
  file_name: z.string().min(1).max(255),
  file_size: z.number().int().min(1),
  mime_type: z.string().min(1).max(100),
  r2_key:    z.string().min(1).max(500),
});

// 10 presign requests per minute per IP — each can authorise a 50 MB upload
const presignLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many upload requests, please try again later' },
});

async function verifyTask(taskId: string, workspaceId: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL',
    [taskId, workspaceId],
  );
  return r.rows.length > 0;
}

// GET /api/tasks/:taskId/attachments
router.get('/', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    if (!await verifyTask(taskId, req.workspace.id)) {
      res.status(404).json({ error: 'Task not found' }); return;
    }
    const result = await pool.query(
      `SELECT ta.*, wm.display_name AS uploader_name
       FROM   task_attachments ta
       LEFT JOIN workspace_members wm
              ON wm.clerk_user_id = ta.uploaded_by AND wm.workspace_id = ta.workspace_id
       WHERE  ta.task_id = $1 AND ta.workspace_id = $2
       ORDER  BY ta.created_at DESC`,
      [taskId, req.workspace.id],
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

// POST /api/tasks/:taskId/attachments/presign — get upload URL
router.post('/presign', presignLimiter, async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    if (!await verifyTask(taskId, req.workspace.id)) {
      res.status(404).json({ error: 'Task not found' }); return;
    }
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { file_name: rawName, file_size, mime_type } = parsed.data;
    if (!ALLOWED_MIME.has(mime_type)) {
      res.status(400).json({ error: 'File type not allowed' }); return;
    }

    const file_name = sanitizeFileName(rawName);                   // H4: sanitize before use
    const ext  = file_name.split('.').pop() ?? 'bin';
    const key  = `attachments/${req.workspace.id}/${taskId}/${randomUUID()}.${ext}`;
    const url  = await getUploadUrl(key, mime_type, file_size);
    res.json({ upload_url: url, r2_key: key, file_name });         // return sanitized name to client
  } catch (err) { next(err); }
});

// POST /api/tasks/:taskId/attachments — confirm (save metadata after upload)
router.post('/', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    if (!await verifyTask(taskId, req.workspace.id)) {
      res.status(404).json({ error: 'Task not found' }); return;
    }
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    // Validate the r2_key belongs to this workspace+task (cross-tenant injection prevention)
    const expected = `attachments/${req.workspace.id}/${taskId}/`;
    if (!parsed.data.r2_key.startsWith(expected)) {
      res.status(400).json({ error: 'Invalid key' }); return;
    }

    const { file_name: rawName, file_size, mime_type, r2_key } = parsed.data;
    const file_name = sanitizeFileName(rawName);

    // C2: Verify the object's actual Content-Type matches the declared MIME
    const mimeOk = await verifyObjectMimeType(r2_key, mime_type);
    if (!mimeOk) {
      // Object content-type mismatch — delete the orphaned object and reject.
      // Log on failure so ops can manually clean up the orphaned R2 object.
      await deleteObject(r2_key).catch((err) => {
        logger.error({ err, r2_key }, 'Failed to delete orphaned R2 object after MIME rejection — manual cleanup required');
      });
      res.status(400).json({ error: 'Uploaded file MIME type does not match the declared type.' }); return;
    }

    // C3: If the DB insert fails, clean up the R2 object to prevent orphans
    let result;
    try {
      result = await pool.query(
        `INSERT INTO task_attachments (task_id, workspace_id, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [taskId, req.workspace.id, file_name, file_size, mime_type, r2_key, req.auth.userId],
      );
    } catch (dbErr) {
      // Best-effort R2 cleanup — do not let a failed delete mask the original error
      await deleteObject(r2_key).catch(() => {});
      throw dbErr;
    }

    res.status(201).json(result.rows[0]);
  } catch (err) { next(err); }
});

// GET /api/tasks/:taskId/attachments/:id/download — presigned download URL
router.get('/:id/download', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    const att = await pool.query(
      'SELECT * FROM task_attachments WHERE id = $1 AND task_id = $2 AND workspace_id = $3',
      [req.params.id, taskId, req.workspace.id],
    );
    if (att.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    const url = await getDownloadUrl(att.rows[0].r2_key, att.rows[0].file_name);
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /api/tasks/:taskId/attachments/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { taskId } = req.params as Record<string, string>;
    const isAdmin = ADMIN_ROLES.has(req.auth.memberRole ?? '');

    const att = await pool.query(
      'SELECT * FROM task_attachments WHERE id = $1 AND task_id = $2 AND workspace_id = $3',
      [req.params.id, taskId, req.workspace.id],
    );
    if (att.rows.length === 0) { res.status(404).json({ error: 'Attachment not found' }); return; }
    if (!isAdmin && att.rows[0].uploaded_by !== req.auth.userId) {
      res.status(403).json({ error: 'Not allowed' }); return;
    }

    // Delete from R2 then DB — re-check workspace_id in the DELETE to close TOCTOU gap
    await deleteObject(att.rows[0].r2_key).catch(() => {/* best effort */});
    await pool.query('DELETE FROM task_attachments WHERE id = $1 AND workspace_id = $2', [req.params.id, req.workspace.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
