import { pool } from '../config/db.js';

const NINJA_CORE_URL   = process.env.NINJA_CORE_URL    ?? 'https://ninja-core.com';
const APP_ID           = process.env.NINJA_CORE_APP_ID ?? '';
const APP_SECRET       = process.env.NINJA_CORE_APP_SECRET ?? '';
const APP_NAME         = 'plan-ninja';
const REVALIDATE_AFTER  = 24 * 60 * 60 * 1000; // 24 h
const FAILURE_BACKOFF   = 60 * 1000;           // 1 min

// C4: Coalesce concurrent revalidation calls for the same workspace into one fetch
const revalidationInFlight = new Map<string, Promise<NinjaCoreResult | null>>();

// Tracks the last time callNinjaCore failed per workspace. Without this, every single request
// while ninja-core is down independently re-triggers a fresh 8s-timeout fetch as soon as the
// prior one settles (the in-flight map only coalesces truly concurrent calls, not sequential
// ones) — amplifying load against an already-struggling service for the whole outage. During
// the backoff window we skip the network call entirely and serve the same optimistic result.
const lastFailedRevalidation = new Map<string, number>();

// M20: the subscription code is a bearer secret (anyone holding it can activate it on their own
// workspace), so it is never part of the status payload returned to workspace members.
export interface SubscriptionStatus {
  active: boolean;
  plan: string | null;
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
    // M20: awaited so a malformed/truncated body is caught here (-> null, "unreachable") instead
    // of escaping as an unhandled rejection past this try/catch.
    return (await res.json()) as NinjaCoreResult;
  } catch {
    return null;
  }
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Status derived from a stored (non-override) row's allowed_apps. Revalidation persists its
 * verdict into allowed_apps: '{}' = code invalid/revoked at ninja-core; a non-empty list without
 * APP_NAME = code valid but doesn't cover this app. Returns null when the row grants access.
 */
function deniedReasonFromApps(apps: string[] | null | undefined): SubscriptionStatus['reason'] | null {
  // Column is NOT NULL; a missing value means "no persisted verdict", not a denial.
  if (apps == null || apps.includes(APP_NAME)) return null;
  return apps.length === 0 ? 'revoked' : 'app_not_allowed';
}

export async function getSubscriptionStatus(workspaceId: string): Promise<SubscriptionStatus> {
  const { rows } = await pool.query(
    `SELECT code, plan, allowed_apps, expires_at, last_verified_at, admin_override
     FROM ninja_stack_subscriptions WHERE workspace_id = $1`,
    [workspaceId],
  );

  if (rows.length === 0) {
    return { active: false, plan: null, expiresAt: null, adminOverride: false, reason: 'no_code' };
  }

  const row = rows[0];

  if (row.admin_override) {
    return { active: true, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: true };
  }

  // Treat expired rows as stale so ninja-core gets a chance to confirm a renewal.
  // Only return 'expired' after revalidation fails or confirms the code is invalid.
  const expired = row.expires_at && new Date(row.expires_at) < new Date();
  const stale   = expired || Date.now() - new Date(row.last_verified_at).getTime() > REVALIDATE_AFTER;

  if (stale) {
    const lastFailure = lastFailedRevalidation.get(workspaceId);
    const inBackoff = lastFailure !== undefined && Date.now() - lastFailure < FAILURE_BACKOFF;

    let result: NinjaCoreResult | null;
    if (inBackoff) {
      result = null;
    } else {
      // C4: coalesce concurrent revalidation fetches for the same workspace
      let inflightPromise = revalidationInFlight.get(workspaceId);
      if (!inflightPromise) {
        inflightPromise = callNinjaCore(row.code).finally(() => {
          revalidationInFlight.delete(workspaceId);
        });
        revalidationInFlight.set(workspaceId, inflightPromise);
      }
      result = await inflightPromise;
      if (result === null) {
        lastFailedRevalidation.set(workspaceId, Date.now());
      } else {
        lastFailedRevalidation.delete(workspaceId);
      }
    }
    if (result === null) {
      // ninja-core unreachable — if cached value is expired fail closed, otherwise serve the last
      // persisted verdict (optimistic only if that verdict granted access).
      if (expired) {
        return { active: false, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false, reason: 'expired' };
      }
      const denied = deniedReasonFromApps(row.allowed_apps);
      if (denied) {
        return { active: false, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false, reason: denied };
      }
      return { active: true, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false };
    }
    if (!result.valid) {
      // M20: persist the negative verdict (allowed_apps = '{}', last_verified_at = now) so a
      // revoked workspace is served from the DB for the next 24h instead of calling ninja-core on
      // every request. The code itself is kept so a later reinstatement is picked up on the next
      // revalidation.
      await pool.query(
        `UPDATE ninja_stack_subscriptions
         SET last_verified_at = NOW(), allowed_apps = '{}' WHERE workspace_id = $1 AND admin_override = FALSE`,
        [workspaceId],
      );
      return { active: false, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false, reason: (result.reason as SubscriptionStatus['reason']) ?? (expired ? 'expired' : 'revoked') };
    }
    const newExpiry = result.expiresAt ? new Date(result.expiresAt) : null;
    const apps = Array.isArray(result.apps) ? result.apps : [];
    await pool.query(
      `UPDATE ninja_stack_subscriptions
       SET last_verified_at = NOW(), expires_at = $1, plan = $2, allowed_apps = $3
       WHERE workspace_id = $4 AND admin_override = FALSE`,
      [newExpiry, result.plan ?? row.plan, apps, workspaceId],
    );
    // M20: same app check as activation — a still-valid code that no longer covers this app
    // must not keep granting access.
    if (!apps.includes(APP_NAME)) {
      return { active: false, plan: result.plan ?? row.plan, expiresAt: toIso(newExpiry), adminOverride: false, reason: 'app_not_allowed' };
    }
    return { active: true, plan: result.plan ?? row.plan, expiresAt: toIso(newExpiry), adminOverride: false };
  }

  const denied = deniedReasonFromApps(row.allowed_apps);
  if (denied) {
    return { active: false, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false, reason: denied };
  }
  return { active: true, plan: row.plan, expiresAt: toIso(row.expires_at), adminOverride: false };
}

export async function activateSubscription(workspaceId: string, code: string): Promise<SubscriptionStatus> {
  const result = await callNinjaCore(code);

  if (result === null) throw new Error('ninja_core_unreachable');
  if (!result.valid) throw new Error(result.reason ?? 'invalid_code');
  if (!result.apps?.includes(APP_NAME)) throw new Error('app_not_allowed');

  // M20: bind a code to one workspace. ninja-core's validate API only accepts { code } (no
  // workspace/tenant binding), so enforce it locally: a code already active on a different
  // workspace can't be activated again elsewhere.
  const inUse = await pool.query(
    `SELECT 1 FROM ninja_stack_subscriptions
     WHERE upper(trim(code)) = upper(trim($1)) AND workspace_id <> $2
     LIMIT 1`,
    [code, workspaceId],
  );
  if (inUse.rows.length > 0) throw new Error('code_in_use');

  const expiresAt = result.expiresAt ? new Date(result.expiresAt) : null;
  const now = new Date();

  // uq_ninja_stack_subscriptions_code (migration 057) closes the race between the check above
  // and this insert; a concurrent activation of the same code elsewhere surfaces as 23505.
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
  ).catch((err: { code?: string }) => {
    if (err?.code === '23505') throw new Error('code_in_use');
    throw err;
  });

  return { active: true, plan: result.plan!, expiresAt: expiresAt?.toISOString() ?? null, adminOverride: false };
}
