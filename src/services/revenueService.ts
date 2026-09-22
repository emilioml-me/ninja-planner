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
  actual_source: 'crm' | 'payments' | null;
  created_at: Date;
  updated_at: Date;
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
  const result = await pool.query<RevenueTarget>(
    `INSERT INTO revenue_targets (workspace_id, period_type, period_start, target_amount, actual_amount, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      workspaceId,
      data.period_type,
      data.period_start,
      data.target_amount,
      data.actual_amount ?? 0,
      data.notes ?? null,
    ],
  );
  return result.rows[0];
}

export async function updateRevenue(
  id: string,
  workspaceId: string,
  data: { period_type?: string; period_start?: string; target_amount?: number; actual_amount?: number; notes?: string },
): Promise<RevenueTarget | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (data.period_type !== undefined)   { fields.push(`period_type = $${i++}`);   values.push(data.period_type); }
  if (data.period_start !== undefined)  { fields.push(`period_start = $${i++}`);  values.push(data.period_start); }
  if (data.target_amount !== undefined) { fields.push(`target_amount = $${i++}`); values.push(data.target_amount); }
  if (data.actual_amount !== undefined) { fields.push(`actual_amount = $${i++}`); values.push(data.actual_amount); }
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
 * OTHER source leaves that month untouched and is reported back as skipped. Rows with
 * actual_source NULL (manual entries / legacy syncs) can be claimed by either source. To switch a
 * month to the other source, delete the row (or clear actual_source) and re-sync.
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

export async function deleteRevenue(id: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM revenue_targets WHERE id = $1 AND workspace_id = $2',
    [id, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
