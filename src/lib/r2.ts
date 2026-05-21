import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

const accountId      = process.env.R2_ACCOUNT_ID     ?? '';
const accessKeyId    = process.env.R2_ACCESS_KEY_ID   ?? '';
const secretKey      = process.env.R2_SECRET_ACCESS_KEY ?? '';
export const bucket  = process.env.R2_BUCKET          ?? 'ninja-planner';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey: secretKey },
});

/** Presigned PUT URL for client-side direct upload (5 min TTL) */
export async function getUploadUrl(key: string, mimeType: string, maxBytes: number): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key:    key,
    ContentType: mimeType,
    ContentLength: maxBytes,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 300 });
}

/** Presigned GET URL for download (1 hour TTL) */
export async function getDownloadUrl(key: string, fileName: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key:    key,
    ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
  });
  return getSignedUrl(r2, cmd, { expiresIn: 3600 });
}

/** Delete an object from R2 */
export async function deleteObject(key: string): Promise<void> {
  await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
