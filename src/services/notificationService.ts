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

export const NOTIFICATION_TYPES = [
  'comment_added', 'mention', 'review_submitted', 'overdue_alert',
  'task_assigned', 'due_date_set', 'task_updated', 'goal_milestone',
  'sprint_ending', 'automation',
] as const;

// Opt-out model: a row only exists once a user mutes a type, so most (workspace, user, type)
// combinations have no row and are implicitly enabled.
export async function isNotificationEnabled(
  workspaceId: string,
  recipientClerkId: string,
  type: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_preferences
     WHERE workspace_id = $1 AND clerk_user_id = $2 AND type = $3`,
    [workspaceId, recipientClerkId, type],
  );
  return rows.length === 0 || rows[0].enabled;
}

export async function getNotificationPreferences(
  workspaceId: string,
  recipientClerkId: string,
): Promise<Record<string, boolean>> {
  const { rows } = await pool.query<{ type: string; enabled: boolean }>(
    `SELECT type, enabled FROM notification_preferences
     WHERE workspace_id = $1 AND clerk_user_id = $2`,
    [workspaceId, recipientClerkId],
  );
  const prefs: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) prefs[t] = true;
  for (const row of rows) prefs[row.type] = row.enabled;
  return prefs;
}

export async function setNotificationPreference(
  workspaceId: string,
  recipientClerkId: string,
  type: string,
  enabled: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO notification_preferences (workspace_id, clerk_user_id, type, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, clerk_user_id, type)
     DO UPDATE SET enabled = $4, updated_at = now()`,
    [workspaceId, recipientClerkId, type, enabled],
  );
}

export async function createNotification(data: {
  workspaceId: string;
  recipientClerkId: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}): Promise<void> {
  const enabled = await isNotificationEnabled(data.workspaceId, data.recipientClerkId, data.type);
  if (!enabled) return;
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

export async function markRead(notificationId: string, recipientId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND recipient_clerk_id = $2 AND workspace_id = $3 AND read_at IS NULL`,
    [notificationId, recipientId, workspaceId],
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
