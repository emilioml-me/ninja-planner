import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Env is read lazily (not at module load) so the app can boot without R2 configured — attachment
// routes check isR2Configured() and return 503 instead of the whole process crashing at import.
export const bucket = process.env.R2_BUCKET ?? 'ninja-planner';

export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
  );
}

let client: S3Client | null = null;

function r2(): S3Client {
  if (client) return client;
  if (!isR2Configured()) {
    throw new Error('R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  client = new S3Client({
    region:      'auto',
    endpoint:    `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
  });
  return client;
}

/** Presigned PUT URLs are short-lived: long enough to start an upload, short enough to limit reuse. */
const UPLOAD_URL_TTL_SECONDS = 120;

/**
 * Presigned PUT URL for client-side direct upload (2 min TTL — see UPLOAD_URL_TTL_SECONDS).
 *
 * Previously took a `maxBytes` param and signed it as `ContentLength` — but Content-Length is a
 * real signed header for S3-compatible presigned PUTs, so that committed the signature to an
 * EXACT byte count, not a maximum: any upload whose actual size differed at all (i.e. almost
 * every real upload, since callers passed the client-reported max/expected size, not the true
 * file size) failed with SignatureDoesNotMatch. The size cap is enforced instead at confirm time
 * via getObjectSize() below, against the real uploaded object — see routes/attachments.ts.
 */
export async function getUploadUrl(key: string, mimeType: string): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket:      bucket,
    Key:         key,
    ContentType: mimeType,
  });
  return getSignedUrl(r2(), cmd, { expiresIn: UPLOAD_URL_TTL_SECONDS });
}

/** Presigned GET URL for download (1 hour TTL) — uses RFC 5987 filename* for Unicode safety (H4) */
export async function getDownloadUrl(key: string, fileName: string): Promise<string> {
  // RFC 5987: filename*=UTF-8''<percent-encoded> for correct Unicode support
  // Also sanitize to strip path separators, null bytes, and CR/LF (the latter previously
  // unstripped — R2/S3 echoes ResponseContentDisposition back verbatim as the Content-Disposition
  // response header, so an unescaped \r\n in a stored filename could inject additional header
  // lines into that response).
  const safeName = fileName
    .replace(/\0/g, '')          // null bytes
    .replace(/[\r\n]/g, '')      // CR/LF — header-splitting guard
    .replace(/[/\\]/g, '_');     // path separators
  const disposition =
    `attachment; filename="${safeName.replace(/"/g, '')}"; ` +
    `filename*=UTF-8''${encodeURIComponent(safeName)}`;

  const cmd = new GetObjectCommand({
    Bucket:                     bucket,
    Key:                        key,
    ResponseContentDisposition: disposition,
  });
  return getSignedUrl(r2(), cmd, { expiresIn: 3600 });
}

/** Verify an uploaded object's Content-Type matches the expected MIME (C2) */
export async function verifyObjectMimeType(key: string, expectedMime: string): Promise<boolean> {
  try {
    const head = await r2().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return (head.ContentType ?? '').split(';')[0].trim() === expectedMime;
  } catch {
    return false; // object not found or error — treat as mismatch
  }
}

/** Real size (bytes) of an uploaded object, or null if it doesn't exist / HEAD fails. */
export async function getObjectSize(key: string): Promise<number | null> {
  try {
    const head = await r2().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

/** Delete an object from R2 */
export async function deleteObject(key: string): Promise<void> {
  await r2().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
