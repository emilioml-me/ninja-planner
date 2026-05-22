import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const accountId   = process.env.R2_ACCOUNT_ID        ?? '';
const accessKeyId = process.env.R2_ACCESS_KEY_ID      ?? '';
const secretKey   = process.env.R2_SECRET_ACCESS_KEY  ?? '';
export const bucket = process.env.R2_BUCKET           ?? 'ninja-planner';

// Fail loudly at startup if credentials are missing (M9)
if (process.env.NODE_ENV !== 'test' && (!accountId || !accessKeyId || !secretKey)) {
  throw new Error(
    'R2 credentials are required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY',
  );
}

export const r2 = new S3Client({
  region:      'auto',
  endpoint:    `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey: secretKey },
});

/** Presigned PUT URL for client-side direct upload (5 min TTL) */
export async function getUploadUrl(key: string, mimeType: string, maxBytes: number): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket:        bucket,
    Key:           key,
    ContentType:   mimeType,
    ContentLength: maxBytes,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 300 });
}

/** Presigned GET URL for download (1 hour TTL) — uses RFC 5987 filename* for Unicode safety (H4) */
export async function getDownloadUrl(key: string, fileName: string): Promise<string> {
  // RFC 5987: filename*=UTF-8''<percent-encoded> for correct Unicode support
  // Also sanitize to strip path separators and null bytes
  const safeName = fileName
    .replace(/\0/g, '')          // null bytes
    .replace(/[/\\]/g, '_');     // path separators
  const disposition =
    `attachment; filename="${safeName.replace(/"/g, '')}"; ` +
    `filename*=UTF-8''${encodeURIComponent(safeName)}`;

  const cmd = new GetObjectCommand({
    Bucket:                     bucket,
    Key:                        key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 3600 });
}

/** Verify an uploaded object's Content-Type matches the expected MIME (C2) */
export async function verifyObjectMimeType(key: string, expectedMime: string): Promise<boolean> {
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return (head.ContentType ?? '').split(';')[0].trim() === expectedMime;
  } catch {
    return false; // object not found or error — treat as mismatch
  }
}

/** Delete an object from R2 */
export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
