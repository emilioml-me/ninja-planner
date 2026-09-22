import { Router } from 'express';
import { z } from 'zod';
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'crypto';
import rateLimit from 'express-rate-limit';
import { requireWorkspace } from '../middleware/requireWorkspace.js';
import { ADMIN_ROLES } from '../middleware/requireAdmin.js';
import { pool } from '../config/db.js';
import { logger } from '../config/logger.js';
import {
  getUploadUrl, getDownloadUrl, deleteObject, verifyObjectMimeType, getObjectSize, isR2Configured,
} from '../lib/r2.js';

// mergeParams: true — :taskId comes from the parent tasks router
const router = Router({ mergeParams: true });
router.use(requireWorkspace);
// R2 is optional at boot (lib/r2.ts is lazy) - without it the attachment feature is unavailable.
router.use((_req, res, next) => {
  if (!isR2Configured()) {
    res.status(503).json({ error: 'File attachments are not configured on this server' });
    return;
  }
  next();
});
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

// -- Upload-key binding (H3) --------------------------------------------------
//
// The presign step issues a key of the form
//   attachments/<workspaceId>/<taskId>/<uuid>-<sig>.<ext>
// where sig = HMAC(uuid | workspaceId | taskId | userId). Confirm recomputes the signature for the
// CALLING user, so a key can only be confirmed by the user it was issued to (previously any member
// could confirm any key under the task prefix - e.g. one scraped from the list response - and a
// failed confirm would then deleteObject() someone else's file). Keeping the binding inside the
// key keeps the presign/confirm request/response contract unchanged for the client.
// The HMAC key is derived from the R2 secret, so no extra env var is required.
function keySigningSecret(): Buffer {
  return createHash('sha256')
    .update('ninja-planner:attachment-key:v1:' + (process.env.R2_SECRET_ACCESS_KEY ?? ''))
    .digest();
}

function signKeyId(uuid: string, workspaceId: string, taskId: string, userId: string): string {
  return createHmac('sha256', keySigningSecret())
    .update(`${uuid}|${workspaceId}|${taskId}|${userId}`)
    .digest('hex')
    .slice(0, 32);
}

const KEY_FILE_RE = /^([0-9a-f-]{36})-([0-9a-f]{32})\.[A-Za-z0-9]{1,20}$/;

function keyIsBoundTo(r2Key: string, workspaceId: string, taskId: string, userId: string): boolean {
  const prefix = `attachments/${workspaceId}/${taskId}/`;
  if (!r2Key.startsWith(prefix)) return false;
  const m = r2Key.slice(prefix.length).match(KEY_FILE_RE);
  if (!m) return false;
  const expected = Buffer.from(signKeyId(m[1], workspaceId, taskId, userId));
  const actual   = Buffer.from(m[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Delete an R2 object only if no task_attachments row references it (never destroy a confirmed file). */
async function deleteObjectIfUnreferenced(r2Key: string, context: string): Promise<void> {
  const ref = await pool.query('SELECT 1 FROM task_attachments WHERE r2_key = $1 LIMIT 1', [r2Key]);
  if (ref.rows.length > 0) return;
  await deleteObject(r2Key).catch((err) => {
    logger.error({ err, r2_key: r2Key }, `Failed to delete R2 object (${context}) - manual cleanup required`);
  });
}

// Columns returned to clients - r2_key is internal (the client never needs it; downloads go
// through /:id/download).
const PUBLIC_COLUMNS = 'ta.id, ta.task_id, ta.workspace_id, ta.file_name, ta.file_size, ta.mime_type, ta.uploaded_by, ta.created_at';

const presignSchema = z.object({
  file_name: z.string().min(1).max(255),
  file_size: z.number().int().min(1).max(MAX_FILE_SIZE),
  mime_type: z.string().min(1).max(100),
});

const confirmSchema = z.object({
  file_name: z.string().min(1).max(255),
  // file_size here is only a client-side hint (used for the presign step) — the confirm handler
  // below re-derives the real, authoritative size via a HEAD request against the uploaded R2
  // object rather than trusting this value, since a client could otherwise submit any number here
  // with no reconciliation against what was actually uploaded (corrupting any future storage-
  // usage/quota reporting built on file_size). Still bounded here for basic shape validation.
  file_size: z.number().int().min(1).max(MAX_FILE_SIZE),
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
      `SELECT ${PUBLIC_COLUMNS}, wm.display_name AS uploader_name
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

    // file_size is only used for the presignSchema's own bounds check above (a client-side
    // sanity hint) — not signed into the upload URL, and not the source of truth for the stored
    // size (see confirmSchema's comment): getUploadUrl no longer takes a size parameter.
    const { file_name: rawName, mime_type } = parsed.data;
    if (!ALLOWED_MIME.has(mime_type)) {
      res.status(400).json({ error: 'File type not allowed' }); return;
    }

    const file_name = sanitizeFileName(rawName);                   // H4: sanitize before use
    const rawExt = file_name.includes('.') ? file_name.split('.').pop() ?? '' : '';
    const ext  = /^[A-Za-z0-9]{1,20}$/.test(rawExt) ? rawExt : 'bin';
    const uuid = randomUUID();
    const sig  = signKeyId(uuid, req.workspace.id, taskId, req.auth.userId);
    const key  = `attachments/${req.workspace.id}/${taskId}/${uuid}-${sig}.${ext}`;
    const url  = await getUploadUrl(key, mime_type);
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

    // Validate the r2_key was issued by presign to THIS user for this workspace+task
    // (cross-tenant / cross-user injection prevention - see keyIsBoundTo).
    const { file_name: rawName, mime_type, r2_key } = parsed.data;
    if (!keyIsBoundTo(r2_key, req.workspace.id, taskId, req.auth.userId)) {
      res.status(400).json({ error: 'Invalid key' }); return;
    }
    const file_name = sanitizeFileName(rawName);

    // Already confirmed (double submit / replay) - reject WITHOUT touching the stored object.
    const existing = await pool.query('SELECT 1 FROM task_attachments WHERE r2_key = $1 LIMIT 1', [r2_key]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Attachment already saved' }); return;
    }

    // C2: Verify the object's actual Content-Type matches the declared MIME
    const mimeOk = await verifyObjectMimeType(r2_key, mime_type);
    if (!mimeOk) {
      // Content-type mismatch (or object missing) - delete the orphaned upload and reject.
      await deleteObjectIfUnreferenced(r2_key, 'MIME rejection');
      res.status(400).json({ error: 'Uploaded file MIME type does not match the declared type.' }); return;
    }

    // The stored file_size is the real, HEAD-derived size of the uploaded object - not the
    // client-supplied value. The presigned PUT cannot bound the size (see lib/r2.ts), so an
    // oversized upload is deleted here.
    const actualSize = await getObjectSize(r2_key);
    if (actualSize === null || actualSize > MAX_FILE_SIZE) {
      await deleteObjectIfUnreferenced(r2_key, 'oversized/unreadable upload');
      res.status(400).json({ error: actualSize === null ? 'Could not read uploaded file' : 'Uploaded file exceeds the 50 MB limit' });
      return;
    }

    // C3: If the DB insert fails, clean up the R2 object to prevent orphans - except on a unique
    // violation (a concurrent confirm of the same key won the race and now owns the object).
    let result;
    try {
      result = await pool.query(
        `INSERT INTO task_attachments (task_id, workspace_id, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, task_id, workspace_id, file_name, file_size, mime_type, uploaded_by, created_at`,
        [taskId, req.workspace.id, file_name, actualSize, mime_type, r2_key, req.auth.userId],
      );
    } catch (dbErr) {
      if ((dbErr as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'Attachment already saved' }); return;
      }
      await deleteObjectIfUnreferenced(r2_key, 'failed insert');
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

    // Delete the row first (re-checking workspace_id to close the TOCTOU gap), then remove the R2
    // object only if no other row still references the same key.
    await pool.query('DELETE FROM task_attachments WHERE id = $1 AND workspace_id = $2', [req.params.id, req.workspace.id]);
    await deleteObjectIfUnreferenced(att.rows[0].r2_key, 'attachment delete');
    res.status(204).send();
  } catch (err) { next(err); }
});

export default router;
