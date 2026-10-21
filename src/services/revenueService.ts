import { pool } from '../config/db.js';

export interface RevenueTarget {
  id: string;
  workspace_id: string;
  period_type: string;
  period_start: string;
  target_amount: string;
  actual_amount: string;
  notes: string | null;
  crm_synced_at: Date | null;
  actual_source: 'crm' | 'payments' | 'manual' | null;
  created_at: Date;
  updated_at: Date;
}

export type RevenuePeriodType = 'monthly' | 'quarterly' | 'yearly';

/**
 * Snap a YYYY-MM-DD date to the first day of its month / quarter / year, so a row entered on the
 * 15th and a sync row on the 1st are the same period (the unique key is on period_start).
 */
export function normalizePeriodStart(periodType: string, ymd: string): string {
  const year = ymd.slice(0, 4);
  let month = Number(ymd.slice(5, 7));
  if (periodType === 'quarterly') month = Math.floor((month - 1) / 3) * 3 + 1;
  else if (periodType === 'yearly') month = 1;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export async function getRevenue(workspaceId: string, limit = 200): Promise<RevenueTarget[]> {
  const result = await pool.query<RevenueTarget>(
    'SELECT * FROM revenue_targets WHERE workspace_id = $1 ORDER BY period_start DESC LIMIT $2',
    [workspaceId, limit],
  );
  return result.rows;
}

export async function createRevenue(
  workspaceId: string,
  data: {
    period_type: string;
    period_start: string;
    target_amount: number;
    actual_amount?: number;
    notes?: string;
  },
): Promise<RevenueTarget> {
  // A non-zero actual typed in by hand is owned by 'manual', so integration syncs leave it alone.
  const manualActual = data.actual_amount !== undefined && data.actual_amount > 0;
  const result = await pool.query<RevenueTarget>(
    `INSERT INTO revenue_targets (workspace_id, period_type, period_start, target_amount, actual_amount, notes, actual_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      workspaceId,
      data.period_type,
      normalizePeriodStart(data.period_type, data.period_start),
      data.target_amount,
      data.actual_amount ?? 0,
      data.notes ?? null,
      manualActual ? 'manual' : null,
    ],
  );
  return result.rows[0];
}

export async function updateRevenue(
  id: string,
  workspaceId: string,
  data: {
    period_type?: string;
    period_start?: string;
    target_amount?: number;
    actual_amount?: number;
    notes?: string | null;
    // Only null is accepted: hands the month back to integration syncs.
    actual_source?: null;
  },
): Promise<RevenueTarget | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (data.period_type !== undefined)   { fields.push(`period_type = $${i++}`);   values.push(data.period_type); }
  if (data.period_start !== undefined || data.period_type !== undefined) {
    // Re-snap period_start whenever either half of the period changes (SET sees the old row, so
    // COALESCE falls back to the stored type/start for whichever wasn't sent).
    const typeIdx = i++;
    const startIdx = i++;
    fields.push(
      `period_start = date_trunc(
         CASE COALESCE($${typeIdx}::text, period_type) WHEN 'quarterly' THEN 'quarter' WHEN 'yearly' THEN 'year' ELSE 'month' END,
         COALESCE($${startIdx}::date, period_start)::timestamp
       )::date`,
    );
    values.push(data.period_type ?? null, data.period_start ?? null);
  }
  if (data.target_amount !== undefined) { fields.push(`target_amount = $${i++}`); values.push(data.target_amount); }
  if (data.actual_amount !== undefined) {
    const idx = i++;
    fields.push(`actual_amount = $${idx}`);
    values.push(data.actual_amount);
    if (data.actual_source === undefined) {
      // Changing the figure by hand takes the month over from whichever sync owned it; re-sending
      // the unchanged value (e.g. a form saving every field) does not.
      fields.push(`actual_source = CASE WHEN actual_amount IS DISTINCT FROM $${idx}::numeric THEN 'manual' ELSE actual_source END`);
    }
  }
  if (data.actual_source === null) {
    // Release ownership; clearing crm_synced_at lets the next sync write regardless of its age.
    fields.push('actual_source = NULL', 'crm_synced_at = NULL');
  }
  if (data.notes !== undefined)         { fields.push(`notes = $${i++}`);         values.push(data.notes); }
  if (fields.length === 0) return null;

  values.push(id, workspaceId);
  const result = await pool.query<RevenueTarget>(
    `UPDATE revenue_targets SET ${fields.join(', ')} WHERE id = $${i++} AND workspace_id = $${i} RETURNING *`,
    values,
  );
  return result.rows[0] ?? null;
}

export type RevenueSyncSource = 'crm' | 'payments';

const SOURCE_NOTE: Record<RevenueSyncSource, string> = {
  crm:      'synced from CRM',
  payments: 'synced from payments',
};

/**
 * Upsert actual_amount for a monthly period from an integration sync.
 * Creates the row with target_amount = 0 if it doesn't exist yet.
 * Idempotent: sets actual_amount to the provided value (replaces, does not add).
 *
 * Source rule (M31): CRM deal sync and payments sync both produce monthly actuals, and they
 * measure the same revenue differently (booked deals vs. collected payments), so they are NOT
 * summed. The first integration to sync a month owns it (actual_source); a later sync from the
 * OTHER source leaves that month untouched and is reported back as skipped. A manual edit of the
 * actual sets actual_source = 'manual', which no sync overwrites. Rows with actual_source NULL
 * (no actual entered / legacy syncs) can be claimed by either source. To hand a month to a sync,
 * PATCH actual_source: null (or delete the row) and re-sync.
 *
 * `syncedAt` should be the time the data was fetched (not when this function runs) — it's
 * compared against the row's stored crm_synced_at (the generic "last synced at" column, despite
 * its name) so that if two syncs from the same source race, a call carrying older data can never
 * clobber a figure that a fresher sync already wrote, regardless of which one commits last.
 *
 * Returns true if the row was written, false if skipped (owned by the other source, or stale).
 */
export async function upsertActualRevenue(
  workspaceId: string,
  periodStart: string,   // YYYY-MM-DD (first of month)
  actualAmount: number,
  syncedAt: Date,
  source: RevenueSyncSource,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO revenue_targets
       (workspace_id, period_type, period_start, target_amount, actual_amount, notes, crm_synced_at, actual_source)
     VALUES ($1, 'monthly', $2, 0, $3, $5, $4, $6)
     ON CONFLICT (workspace_id, period_type, period_start)
     DO UPDATE SET
       actual_amount = $3,
       crm_synced_at = $4,
       actual_source = $6,
       notes = COALESCE(revenue_targets.notes, $5)
     WHERE (revenue_targets.actual_source IS NULL OR revenue_targets.actual_source = $6)
       AND (revenue_targets.crm_synced_at IS NULL OR revenue_targets.crm_synced_at < $4)`,
    [workspaceId, periodStart, actualAmount, syncedAt, SOURCE_NOTE[source], source],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Zero out monthly actuals a sync previously wrote from `source` that the latest sync no longer
 * produced, limited to the window that sync fully covered (period_start > `after`, or every month
 * when `after` is null). Rows stay owned by `source`. Same staleness guard as upsertActualRevenue.
 * Returns the reset period_starts (YYYY-MM-DD).
 */
export async function resetStaleSyncedRevenue(
  workspaceId: string,
  source: RevenueSyncSource,
  keepPeriodStarts: string[],
  after: string | null,
  syncedAt: Date,
): Promise<string[]> {
  const result = await pool.query<{ period_start: string }>(
    `UPDATE revenue_targets
     SET actual_amount = 0, crm_synced_at = $5
     WHERE workspace_id = $1
       AND period_type = 'monthly'
       AND actual_source = $2
       AND actual_amount <> 0
       AND NOT (period_start = ANY($3::date[]))
       AND ($4::date IS NULL OR period_start > $4::date)
       AND (crm_synced_at IS NULL OR crm_synced_at < $5)
     RETURNING to_char(period_start, 'YYYY-MM-DD') AS period_start`,
    [workspaceId, source, keepPeriodStarts, after, syncedAt],
  );
  return result.rows.map((r) => r.period_start);
}

export async function deleteRevenue(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM revenue_targets WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
