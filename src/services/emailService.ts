import { Resend } from 'resend';
import { clerkClient } from '../config/clerk.js';
import { logger } from '../config/logger.js';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM_ADDRESS = process.env.EMAIL_FROM ?? 'Plan Ninja <no-reply@plan-ninja.com>';

/**
 * Send a transactional email via Resend.
 * Silently no-ops if RESEND_API_KEY is not configured (dev/test envs).
 */
export async function sendEmail(opts: {
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
    await resend.emails.send({
      from: FROM_ADDRESS,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
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
      <h1>Plan Ninja</h1>
      <span>plan-ninja.com</span>
    </div>
    <div class="body">${body}</div>
    <div class="footer">You received this email because you are a member of a Plan Ninja workspace.<br/>© ${new Date().getFullYear()} Plan Ninja</div>
  </div>
</body>
</html>`;
}

// ── Typed email senders ───────────────────────────────────────────────────────

export async function sendTaskAssignedEmail(opts: {
  to: string;
  recipientName: string;
  taskTitle: string;
  assigner: string;
  workspaceUrl: string;
}): Promise<void> {
  const body = `
    <h2>You've been assigned a task</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p><strong>${escHtml(opts.assigner)}</strong> assigned you the task <strong>"${escHtml(opts.taskTitle)}"</strong>.</p>
    <a href="${opts.workspaceUrl}/tasks" class="cta">View Task</a>
    <p style="color:#71717a;font-size:13px">If you weren't expecting this, you can ignore this email.</p>
  `;
  await sendEmail({
    to: opts.to,
    subject: `Task assigned: "${opts.taskTitle}"`,
    html: layout('Task Assigned', body),
    text: `${opts.assigner} assigned you "${opts.taskTitle}". Open: ${opts.workspaceUrl}/tasks`,
  });
}

export async function sendDueDateReminderEmail(opts: {
  to: string;
  recipientName: string;
  taskTitle: string;
  dueDate: string;
  workspaceUrl: string;
}): Promise<void> {
  const body = `
    <h2>Task due soon</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p>This is a reminder that <strong>"${escHtml(opts.taskTitle)}"</strong> is due on <strong>${escHtml(opts.dueDate)}</strong>.</p>
    <a href="${opts.workspaceUrl}/tasks" class="cta">Open Task</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `Due date reminder: "${opts.taskTitle}" — ${opts.dueDate}`,
    html: layout('Due Date Reminder', body),
    text: `"${opts.taskTitle}" is due on ${opts.dueDate}. Open: ${opts.workspaceUrl}/tasks`,
  });
}

export async function sendCommentMentionEmail(opts: {
  to: string;
  recipientName: string;
  commenter: string;
  taskTitle: string;
  commentBody: string;
  workspaceUrl: string;
}): Promise<void> {
  const preview = opts.commentBody.length > 200
    ? opts.commentBody.slice(0, 197) + '…'
    : opts.commentBody;
  const body = `
    <h2>You were mentioned in a comment</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p><strong>${escHtml(opts.commenter)}</strong> mentioned you on <strong>"${escHtml(opts.taskTitle)}"</strong>:</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;background:#f4f4f5;border-left:3px solid #18181b;border-radius:4px;font-size:14px;color:#3f3f46;">
      ${escHtml(preview)}
    </blockquote>
    <a href="${opts.workspaceUrl}/tasks" class="cta">View Comment</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `${opts.commenter} mentioned you on "${opts.taskTitle}"`,
    html: layout('You Were Mentioned', body),
    text: `${opts.commenter} mentioned you on "${opts.taskTitle}": ${preview}\n\nOpen: ${opts.workspaceUrl}/tasks`,
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
  const body = `
    <h2>${headline}</h2>
    <p>Hi ${escHtml(opts.recipientName)},</p>
    <p>Your goal <strong>"${escHtml(opts.goalTitle)}"</strong> just reached <strong>${opts.milestone}</strong> completion${is100 ? ' — congratulations!' : '.'}
    </p>
    <a href="${opts.workspaceUrl}/goals" class="cta">View Goal</a>
  `;
  await sendEmail({
    to: opts.to,
    subject: `${headline}: "${opts.goalTitle}"`,
    html: layout('Goal Milestone', body),
    text: `${headline} — "${opts.goalTitle}" reached ${opts.milestone}. Open: ${opts.workspaceUrl}/goals`,
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
