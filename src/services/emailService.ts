import { Resend } from 'resend';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';
import { getPublicAppUrl } from '../config/origins.js';
import { trackBackground } from '../lib/background.js';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const BRAND = 'Ninja Planner';
const FROM_ADDRESS = process.env.EMAIL_FROM?.trim() || `${BRAND} <no-reply@ninja-planner.com>`;

/**
 * Send a transactional email via Resend.
 * Silently no-ops if RESEND_API_KEY is not configured (dev/test envs).
 * The send is registered with trackBackground so a graceful shutdown waits for in-flight
 * emails even when the caller fired it without awaiting.
 */
export function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  return trackBackground(deliverEmail(opts));
}

async function deliverEmail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!resend) {
    logger.info({ to: opts.to, subject: opts.subject }, 'email skipped — no RESEND_API_KEY');
    return;
  }
  try {
    // Resend v6 does not throw on API errors — it resolves { data, error }. Check `error`
    // explicitly, otherwise rejected sends (bad from-domain, invalid recipient, rate limit)
    // are silently treated as delivered.
    const { error } = await resend.emails.send({
      from: FROM_ADDRESS,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    if (error) {
      logger.error({ err: error, to: opts.to, subject: opts.subject }, 'resend email rejected');
    }
  } catch (err) {
    logger.error({ err, to: opts.to, subject: opts.subject }, 'resend email failed');
  }
}

// ── Template helpers ──────────────────────────────────────────────────────────

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width:560px; margin:40px auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.12); }
    .header  { background:#18181b; padding:20px 32px; }
    .header h1 { margin:0; color:#fff; font-size:18px; font-weight:600; }
    .header span { color:#a1a1aa; font-size:13px; }
    .body    { padding:32px; color:#18181b; line-height:1.6; }
    .body h2 { margin:0 0 12px; font-size:17px; }
    .body p  { margin:0 0 16px; font-size:14px; color:#3f3f46; }
    .cta     { display:inline-block; margin:8px 0 24px; padding:10px 20px; background:#18181b; color:#fff !important; border-radius:6px; text-decoration:none; font-size:14px; font-weight:500; }
    .footer  { padding:16px 32px; background:#f4f4f5; color:#71717a; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>${BRAND}</h1>
      <span>ninja-planner.com</span>
    </div>
    <div class="body">${body}</div>
    <div class="footer">You received this email because you are a member of a ${BRAND} workspace.<br/>&copy; ${new Date().getFullYear()} ${BRAND}</div>
  </div>
</body>
</html>`;
}

// ── Typed email senders ───────────────────────────────────────────────────────

/**
 * `assigner` is a human display name (callers resolve it via workspaceService.getMemberDisplayName).
 * A raw Clerk user id is never shown - it falls back to "A teammate".
 * `workspaceUrl` may be empty: links then use getPublicAppUrl(). With `taskId` the link opens the task.
 */
export async function sendTaskAssignedEmail(opts: {
  to: string;
  recipientName: string;
  taskTitle: string;
  assigner: string;
  workspaceUrl: string;
  taskId?: string;
}): Promise<void> {
  const assigner = displayName(opts.assigner);
  const link = taskLink(opts.workspaceUrl, opts.taskId);
  const body = `
    <h2>You've been assigned a task</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p><strong>${escHtml(assigner)}</strong> assigned you the task <strong>"${escHtml(opts.taskTitle)}"</strong>.</p>
    <a href="${escHtml(link)}" class="cta">View Task</a>
    <p style="color:#71717a;font-size:13px">If you weren't expecting this, you can ignore this email.</p>
  `;
  await sendEmail({
    to: opts.to,
    subject: `Task assigned: "${opts.taskTitle}"`,
    html: layout('Task Assigned', body),
    text: `${assigner} assigned you "${opts.taskTitle}". Open: ${link}`,
  });
}

export async function sendDueDateReminderEmail(opts: {
  to: string;
  recipientName: string;
  taskTitle: string;
  dueDate: string;
  workspaceUrl: string;
  taskId?: string;
}): Promise<void> {
  const link = taskLink(opts.workspaceUrl, opts.taskId);
  const body = `
    <h2>Task due soon</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p>This is a reminder that <strong>"${escHtml(opts.taskTitle)}"</strong> is due on <strong>${escHtml(opts.dueDate)}</strong>.</p>
    <a href="${escHtml(link)}" class="cta">Open Task</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `Due date reminder: "${opts.taskTitle}" - ${opts.dueDate}`,
    html: layout('Due Date Reminder', body),
    text: `"${opts.taskTitle}" is due on ${opts.dueDate}. Open: ${link}`,
  });
}

export async function sendCommentMentionEmail(opts: {
  to: string;
  recipientName: string;
  commenter: string;
  taskTitle: string;
  commentBody: string;
  workspaceUrl: string;
  taskId?: string;
}): Promise<void> {
  const commenter = displayName(opts.commenter);
  const link = taskLink(opts.workspaceUrl, opts.taskId);
  const preview = opts.commentBody.length > 200
    ? opts.commentBody.slice(0, 197) + '...'
    : opts.commentBody;
  const body = `
    <h2>You were mentioned in a comment</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p><strong>${escHtml(commenter)}</strong> mentioned you on <strong>"${escHtml(opts.taskTitle)}"</strong>:</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;background:#f4f4f5;border-left:3px solid #18181b;border-radius:4px;font-size:14px;color:#3f3f46;">
      ${escHtml(preview)}
    </blockquote>
    <a href="${escHtml(link)}" class="cta">View Comment</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `${commenter} mentioned you on "${opts.taskTitle}"`,
    html: layout('You Were Mentioned', body),
    text: `${commenter} mentioned you on "${opts.taskTitle}": ${preview}\n\nOpen: ${link}`,
  });
}

export async function sendCommentAddedEmail(opts: {
  to: string;
  recipientName: string;
  commenter: string;
  taskTitle: string;
  commentBody: string;
  workspaceUrl: string;
  taskId?: string;
}): Promise<void> {
  const commenter = displayName(opts.commenter);
  const link = taskLink(opts.workspaceUrl, opts.taskId);
  const preview = opts.commentBody.length > 200
    ? opts.commentBody.slice(0, 197) + '...'
    : opts.commentBody;
  const body = `
    <h2>New comment on a task</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p><strong>${escHtml(commenter)}</strong> commented on <strong>"${escHtml(opts.taskTitle)}"</strong>:</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;background:#f4f4f5;border-left:3px solid #18181b;border-radius:4px;font-size:14px;color:#3f3f46;">
      ${escHtml(preview)}
    </blockquote>
    <a href="${escHtml(link)}" class="cta">View Comment</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `${commenter} commented on "${opts.taskTitle}"`,
    html: layout('New Comment', body),
    text: `${commenter} commented on "${opts.taskTitle}": ${preview}\n\nOpen: ${link}`,
  });
}

export async function sendGoalMilestoneEmail(opts: {
  to: string;
  recipientName: string;
  goalTitle: string;
  milestone: '50%' | '100%';
  workspaceUrl: string;
}): Promise<void> {
  const is100 = opts.milestone === '100%';
  const headline = is100 ? `🎉 Goal complete!` : `Halfway there (50%)`;
  const link = `${appBase(opts.workspaceUrl)}/goals`;
  const body = `
    <h2>${headline}</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p>Your goal <strong>"${escHtml(opts.goalTitle)}"</strong> just reached <strong>${opts.milestone}</strong> completion${is100 ? ' - congratulations!' : '.'}
    </p>
    <a href="${escHtml(link)}" class="cta">View Goal</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `${headline}: "${opts.goalTitle}"`,
    html: layout('Goal Milestone', body),
    text: `${headline} - "${opts.goalTitle}" reached ${opts.milestone}. Open: ${link}`,
  });
}

// ── Clerk user resolver ───────────────────────────────────────────────────────

/**
 * Resolve a Clerk user's primary email and display name.
 * Returns null on any error so callers can safely fire-and-forget.
 */
export async function resolveClerkEmail(
  clerkUserId: string,
): Promise<{ email: string; name: string } | null> {
  try {
    const user = await clerkClient.users.getUser(clerkUserId);
    const emailObj = user.emailAddresses.find(
      (e) => e.id === user.primaryEmailAddressId,
    ) ?? user.emailAddresses[0];
    if (!emailObj) return null;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || emailObj.emailAddress.split('@')[0];
    return { email: emailObj.emailAddress, name };
  } catch {
    return null;
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Returns the URL only if it starts with https:// or http://, otherwise empty string. */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '';
}

/** Absolute app base URL for links: the caller's URL if valid, else the configured public URL. */
function appBase(url: string | undefined): string {
  return (safeHref(url ?? '') || getPublicAppUrl()).replace(/\/+$/, '');
}

/** Link to the task list, or to one task (`/tasks?task=<id>`) when an id is known. */
function taskLink(url: string | undefined, taskId?: string): string {
  const base = `${appBase(url)}/tasks`;
  return taskId ? `${base}?task=${encodeURIComponent(taskId)}` : base;
}

/** Never print a raw Clerk user id (user_...) or an empty string as a person's name. */
function displayName(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n || /^user_[A-Za-z0-9]+$/.test(n)) return 'A teammate';
  return n;
}
