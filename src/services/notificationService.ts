import { pool } from '../config/db.js';

export interface Notification {
  id: string;
  workspace_id: string;
  recipient_clerk_id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}

export async function createNotification(data: {
  workspaceId: string;
  recipientClerkId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (workspace_id, recipient_clerk_id, type, title, body, link)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.workspaceId,
      data.recipientClerkId,
      data.type,
      data.title,
      data.body ?? null,
      data.link ?? null,
    ],
  );
}

export async function getNotifications(
  workspaceId: string,
  recipientId: string,
  limit = 50,
): Promise<Notification[]> {
  const result = await pool.query<Notification>(
    `SELECT * FROM notifications
     WHERE workspace_id = $1 AND recipient_clerk_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [workspaceId, recipientId, limit],
  );
  return result.rows;
}

export async function markRead(notificationId: string, recipientId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND recipient_clerk_id = $2 AND read_at IS NULL`,
    [notificationId, recipientId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markAllRead(workspaceId: string, recipientId: string): Promise<void> {
  await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE workspace_id = $1 AND recipient_clerk_id = $2 AND read_at IS NULL`,
    [workspaceId, recipientId],
  );
}

export async function getUnreadCount(
  workspaceId: string,
  recipientId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM notifications
     WHERE workspace_id = $1 AND recipient_clerk_id = $2 AND read_at IS NULL`,
    [workspaceId, recipientId],
  );
  return parseInt(result.rows[0].count, 10);
}
