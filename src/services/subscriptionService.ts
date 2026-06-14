import { pool } from '../config/db.js';

const NINJA_CORE_URL   = process.env.NINJA_CORE_URL    ?? 'https://ninja-core.com';
const APP_ID           = process.env.NINJA_CORE_APP_ID ?? '';
const APP_SECRET       = process.env.NINJA_CORE_APP_SECRET ?? '';
const APP_NAME         = 'plan-ninja';
const REVALIDATE_AFTER = 24 * 60 * 60 * 1000; // 24 h

// C4: Coalesce concurrent revalidation calls for the same workspace into one fetch
const revalidationInFlight = new Map<string, Promise<NinjaCoreResult | null>>();

export interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
  code: string | null;
  expiresAt: string | null;
  adminOverride: boolean;
  reason?: 'no_code' | 'expired' | 'app_not_allowed' | 'revoked' | 'ninja_core_unreachable';
}

interface NinjaCoreResult {
  valid: boolean;
  plan?: string;
  apps?: string[];
  customerEmail?: string;
  expiresAt?: string;
  reason?: string;
}

async function callNinjaCore(code: string): Promise<NinjaCoreResult | null> {
  if (!APP_ID || !APP_SECRET) return null;
  try {
    const res = await fetch(`${NINJA_CORE_URL}/api/subscriptions/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-ID': APP_ID,
        'X-App-Secret': APP_SECRET,
      },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<NinjaCoreResult>;
  } catch {
    return null;
  }
}

export async function getSubscriptionStatus(workspaceId: string): Promise<SubscriptionStatus> {
  const { rows } = await pool.query(
    `SELECT code, plan, expires_at, last_verified_at, admin_override
     FROM ninja_stack_subscriptions WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (rows.length === 0) {
    return { active: false, plan: null, code: null, expiresAt: null, adminOverride: false, reason: 'no_code' };
  }

  const row = rows[0];

  if (row.admin_override) {
    return { active: true, plan: row.plan, code: row.code, expiresAt: row.expires_at?.toISOString() ?? null, adminOverride: true };
  }

  // Treat expired rows as stale so ninja-core gets a chance to confirm a renewal.
  // Only return 'expired' after revalidation fails or confirms the code is invalid.
  const expired = row.expires_at && new Date(row.expires_at) < new Date();
  const stale   = expired || Date.now() - new Date(row.last_verified_at).getTime() > REVALIDATE_AFTER;

  if (stale) {
    // C4: coalesce concurrent revalidation fetches for the same workspace
    let inflightPromise = revalidationInFlight.get(workspaceId);
    if (!inflightPromise) {
      inflightPromise = callNinjaCore(row.code).finally(() => {
        revalidationInFlight.delete(workspaceId);
      });
      revalidationInFlight.set(workspaceId, inflightPromise);
    }
    const result = await inflightPromise;
    if (result === null) {
      // ninja-core unreachable — if cached value is expired fail closed, otherwise serve optimistically
      if (expired) {
        return { active: false, plan: row.plan, code: row.code, expiresAt: row.expires_at!.toISOString(), adminOverride: false, reason: 'expired' };
      }
      return { active: true, plan: row.plan, code: row.code, expiresAt: row.expires_at?.toISOString() ?? null, adminOverride: false };
    }
    if (!result.valid) {
      return { active: false, plan: row.plan, code: row.code, expiresAt: row.expires_at?.toISOString() ?? null, adminOverride: false, reason: (result.reason as SubscriptionStatus['reason']) ?? 'revoked' };
    }
    const newExpiry = result.expiresAt ? new Date(result.expiresAt) : null;
    await pool.query(
      `UPDATE ninja_stack_subscriptions
       SET last_verified_at = NOW(), expires_at = $1, plan = $2 WHERE workspace_id = $3`,
      [newExpiry, result.plan ?? row.plan, workspaceId],
    );
    return { active: true, plan: result.plan ?? row.plan, code: row.code, expiresAt: newExpiry?.toISOString() ?? null, adminOverride: false };
  }

  return { active: true, plan: row.plan, code: row.code, expiresAt: row.expires_at?.toISOString() ?? null, adminOverride: false };
}

export async function activateSubscription(workspaceId: string, code: string): Promise<SubscriptionStatus> {
  const result = await callNinjaCore(code);

  if (result === null) throw new Error('ninja_core_unreachable');
  if (!result.valid) throw new Error(result.reason ?? 'invalid_code');
  if (!result.apps?.includes(APP_NAME)) throw new Error('app_not_allowed');

  const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null;
  const now = new Date();

  await pool.query(
    `INSERT INTO ninja_stack_subscriptions
       (workspace_id, code, plan, allowed_apps, customer_email, expires_at, activated_at, last_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (workspace_id) DO UPDATE SET
       code = EXCLUDED.code,
       plan = EXCLUDED.plan,
       allowed_apps = EXCLUDED.allowed_apps,
       customer_email = EXCLUDED.customer_email,
       expires_at = EXCLUDED.expires_at,
       activated_at = EXCLUDED.activated_at,
       last_verified_at = EXCLUDED.last_verified_at,
       admin_override = FALSE,
       overridden_by = NULL`,
    [workspaceId, code, result.plan, result.apps, result.customerEmail ?? null, expiresAt, now],
  );

  return { active: true, plan: result.plan!, code, expiresAt: expiresAt?.toISOString() ?? null, adminOverride: false };
}
